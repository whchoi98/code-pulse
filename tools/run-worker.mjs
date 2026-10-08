import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { parseArgs, promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';

const run = promisify(execFile);
const { values } = parseArgs({
  options: {
    'dry-run': { type: 'boolean', default: false },
    wait: { type: 'boolean', default: false },
    'refresh-model': { type: 'boolean', default: false },
    'no-ai': { type: 'boolean', default: false },
    since: { type: 'string' },
    days: { type: 'string' },
    concurrency: { type: 'string' },
    'max-summaries': { type: 'string' },
    'max-full-changes': { type: 'string' },
  },
});
if (values.since && values.days) throw new Error('--since와 --days는 함께 지정할 수 없습니다.');
for (const [name, min, max] of [['days', 1, 365], ['max-summaries', 0, 300], ['max-full-changes', 0, 300], ['concurrency', 1, 6]]) {
  if (values[name] !== undefined && (!/^\d+$/.test(values[name]) || Number(values[name]) < min || Number(values[name]) > max)) {
    throw new Error(`${name} 값은 ${min}~${max} 범위의 정수여야 합니다.`);
  }
}
if (values.since && (!/^\d{4}-\d{2}-\d{2}$/.test(values.since)
  || Number.isNaN(Date.parse(`${values.since}T00:00:00Z`))
  || new Date(`${values.since}T00:00:00Z`).toISOString().slice(0, 10) !== values.since)) {
  throw new Error('--since는 유효한 YYYY-MM-DD 날짜여야 합니다.');
}
const outputs = JSON.parse(await readFile('cdk-outputs.json', 'utf8')).CodePulse;
for (const name of ['ClusterName', 'WorkerTaskDefinitionArn', 'WorkerSecurityGroupId', 'PrivateSubnetIds']) {
  if (typeof outputs?.[name] !== 'string' || !outputs[name]) throw new Error(`스택 출력이 없습니다: ${name}`);
}
if (!outputs.WorkerTaskDefinitionArn.startsWith('arn:aws:ecs:ap-northeast-2:061525506239:task-definition/')) {
  throw new Error('이 프로젝트의 배포 계정과 리전에 해당하는 태스크가 아닙니다.');
}
const region = 'ap-northeast-2';
const network = {
  awsvpcConfiguration: {
    subnets: outputs.PrivateSubnetIds.split(','),
    securityGroups: [outputs.WorkerSecurityGroupId],
    assignPublicIp: 'DISABLED',
  },
};
const command = ['node', 'dist/collector/run.js'];
for (const name of ['refresh-model', 'no-ai']) if (values[name]) command.push(`--${name}`);
for (const name of ['since', 'days', 'max-summaries', 'max-full-changes', 'concurrency']) if (values[name] !== undefined) command.push(`--${name}`, values[name]);
const input = {
  cluster: outputs.ClusterName, taskDefinition: outputs.WorkerTaskDefinitionArn,
  launchType: 'FARGATE', count: 1, networkConfiguration: network,
  ...(command.length > 2 ? {
    overrides: { containerOverrides: [{ name: 'collector', command }] },
  } : {}),
};
if (values['dry-run']) {
  console.log(JSON.stringify(input, null, 2));
} else {
  const aws = async parameters => {
    const { stdout } = await run('aws', [...parameters, '--region', region, '--output', 'json'], { maxBuffer: 4 * 1024 * 1024 });
    return JSON.parse(stdout);
  };
  const identity = await aws(['sts', 'get-caller-identity']);
  if (identity.Account !== '061525506239') throw new Error('현재 AWS 계정이 배포 계정과 다릅니다.');
  const response = await aws(['ecs', 'run-task', '--cli-input-json', JSON.stringify(input)]);
  if (response.failures?.length || !response.tasks?.[0]?.taskArn) {
    throw new Error(`수집 태스크를 시작하지 못했습니다: ${JSON.stringify(response.failures)}`);
  }
  const taskArn = response.tasks[0].taskArn;
  console.log(JSON.stringify({ event: 'worker_started', taskArn }));
  if (values.wait) {
    const deadline = Date.now() + 25 * 60_000;
    let previousStatus = '';
    let stopped = false;
    while (Date.now() < deadline) {
      const status = await aws(['ecs', 'describe-tasks', '--cluster', outputs.ClusterName, '--tasks', taskArn]);
      const task = status.tasks?.[0];
      if (task?.lastStatus && task.lastStatus !== previousStatus) {
        previousStatus = task.lastStatus;
        console.log(JSON.stringify({ event: 'worker_status', taskArn, status: previousStatus }));
      }
      if (task?.lastStatus === 'STOPPED') {
        const collector = task.containers?.find(container => container.name === 'collector');
        console.log(JSON.stringify({
          event: 'worker_stopped', taskArn, exitCode: collector?.exitCode,
          stopCode: task.stopCode, reason: task.stoppedReason, logGroup: outputs.CollectorLogGroupName,
        }));
        if (collector?.exitCode !== 0) process.exitCode = 1;
        stopped = true;
        break;
      }
      await delay(15_000);
    }
    if (!stopped) {
      console.error(JSON.stringify({ event: 'worker_observation_timeout', taskArn, message: '같은 태스크 ARN으로 상태를 다시 확인하세요. 새 태스크는 시작하지 않았습니다.' }));
      process.exitCode = 2;
    }
  }
}

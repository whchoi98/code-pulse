import { execFile } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';

const run = promisify(execFile);
const outputs = JSON.parse(await readFile('cdk-outputs.json', 'utf8')).CodePulse;
const region = 'ap-northeast-2';
const aws = async parameters => {
  const { stdout } = await run('aws', [...parameters, '--region', region, '--output', 'json'], { maxBuffer: 4 * 1024 * 1024, timeout: 30_000 });
  return stdout.trim() ? JSON.parse(stdout) : {};
};
const identity = await aws(['sts', 'get-caller-identity']);
if (identity.Account !== '061525506239') throw new Error('배포 계정과 현재 AWS 계정이 다릅니다.');
const daily = await aws(['scheduler', 'get-schedule', '--name', outputs.ScheduleName, '--group-name', outputs.ScheduleGroupName]);
if (daily.Target.EcsParameters.TaskDefinitionArn !== outputs.WorkerTaskDefinitionArn) throw new Error('일정과 배포 태스크가 일치하지 않습니다.');
const started = Date.now();
const scheduledAt = new Date(Math.ceil((started + 90_000) / 60_000) * 60_000);
const name = `code-pulse-verify-${started}`;
const config = {
  Name: name, GroupName: outputs.ScheduleGroupName,
  Description: 'One-time verification of the production collector target; automatically removed',
  ScheduleExpression: `at(${scheduledAt.toISOString().slice(0, 19)})`,
  ScheduleExpressionTimezone: 'UTC', FlexibleTimeWindow: { Mode: 'OFF' },
  State: 'ENABLED', ActionAfterCompletion: 'DELETE', Target: daily.Target,
};
const created = await aws(['scheduler', 'create-schedule', '--cli-input-json', JSON.stringify(config)]);
const report = { scheduleArn: created.ScheduleArn, name, scheduledAt: scheduledAt.toISOString(), target: daily.Target, observedGuardDutyRunning: false };
await writeFile('docs/scheduler-verification.json', JSON.stringify(report, null, 2));
console.log(JSON.stringify({ event: 'verification_scheduled', name, scheduledAt: report.scheduledAt }));
const family = outputs.WorkerTaskDefinitionArn.split('/').at(-1).split(':')[0];
let taskArn;
let previous = '';
let completed = false;
const deadline = started + 25 * 60_000;
while (Date.now() < deadline) {
  if (Date.now() < scheduledAt.getTime() - 5000) { await delay(15_000); continue; }
  if (!taskArn) {
    const lists = await Promise.all(['RUNNING', 'STOPPED'].map(status =>
      aws(['ecs', 'list-tasks', '--cluster', outputs.ClusterName, '--family', family, '--desired-status', status])));
    const arns = [...new Set(lists.flatMap(list => list.taskArns ?? []))];
    if (arns.length) {
      const described = await aws(['ecs', 'describe-tasks', '--cluster', outputs.ClusterName, '--tasks', ...arns]);
      const candidate = (described.tasks ?? []).filter(task => task.taskDefinitionArn === outputs.WorkerTaskDefinitionArn && Date.parse(task.createdAt) >= started)
        .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0];
      taskArn = candidate?.taskArn;
      if (taskArn) {
        report.taskArn = taskArn;
        await writeFile('docs/scheduler-verification.json', JSON.stringify(report, null, 2));
        console.log(JSON.stringify({ event: 'scheduled_worker_found', taskArn }));
      }
    }
  }
  if (taskArn) {
    const response = await aws(['ecs', 'describe-tasks', '--cluster', outputs.ClusterName, '--tasks', taskArn]);
    const task = response.tasks?.[0];
    if (task) {
      if (task.containers?.some(container => container.name.startsWith('aws-guardduty-agent-') && container.lastStatus === 'RUNNING')) report.observedGuardDutyRunning = true;
      if (task.lastStatus !== previous) {
        previous = task.lastStatus;
        console.log(JSON.stringify({ event: 'scheduled_worker_status', status: previous }));
      }
      if (task.lastStatus === 'STOPPED') {
        const collector = task.containers.find(container => container.name === 'collector');
        report.completedAt = new Date().toISOString();
        report.exitCode = collector?.exitCode;
        report.containers = task.containers.map(container => ({ name: container.name, status: container.lastStatus, exitCode: container.exitCode, reason: container.reason }));
        report.stopCode = task.stopCode;
        report.stoppedReason = task.stoppedReason;
        await writeFile('docs/scheduler-verification.json', JSON.stringify(report, null, 2));
        console.log(JSON.stringify({ event: 'scheduled_worker_completed', ...report }));
        if (collector?.exitCode !== 0) process.exitCode = 1;
        completed = true;
        break;
      }
    }
  }
  await delay(5000);
}
if (!completed) {
  console.error(JSON.stringify({ event: 'verification_observation_timeout', name, taskArn, message: '새 작업을 시작하지 말고 같은 일정 또는 태스크를 조회하세요.' }));
  process.exitCode = 2;
}

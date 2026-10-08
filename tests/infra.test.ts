import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { App, Aspects } from 'aws-cdk-lib';
import { Annotations, Match, Template } from 'aws-cdk-lib/assertions';
import { AwsSolutionsChecks } from 'cdk-nag';
import { CodePulseStack } from '../infra/lib/stack.js';

const publicSubnets = ['subnet-08486a1e618b1991e', 'subnet-0c161777c4031c320'];
const privateSubnets = ['subnet-07b1e65682847dce9', 'subnet-095297380cd45e1eb'];
const outputDirectory = mkdtempSync(join(tmpdir(), 'code-pulse-infra-'));
let stack: CodePulseStack;
let template: Template;

type Resource = { Type: string; Properties: Record<string, any>; DeletionPolicy?: string };
type Statement = { Effect: string; Action: string | string[]; Resource: unknown; Condition?: Record<string, any> };

function resources(type: string): Array<[string, Resource]> {
  return Object.entries(template.findResources(type)) as Array<[string, Resource]>;
}

function task(containerName: string): [string, Resource] {
  const resource = resources('AWS::ECS::TaskDefinition')
    .find(([, value]) => value.Properties.ContainerDefinitions.some((container: any) => container.Name === containerName));
  expect(resource, `${containerName} task definition`).toBeDefined();
  return resource!;
}

function roleStatements(roleArn: { 'Fn::GetAtt': [string, string] }): Statement[] {
  const roleId = roleArn['Fn::GetAtt'][0];
  return resources('AWS::IAM::Policy')
    .filter(([, resource]) => resource.Properties.Roles?.some((role: any) => role.Ref === roleId))
    .flatMap(([, resource]) => resource.Properties.PolicyDocument.Statement);
}

function actions(statement: Statement): string[] {
  return Array.isArray(statement.Action) ? statement.Action : [statement.Action];
}

beforeAll(() => {
  const app = new App({ outdir: outputDirectory });
  stack = new CodePulseStack(app, 'CodePulse', {
    env: { account: '061525506239', region: 'ap-northeast-2' },
  });
  Aspects.of(app).add(new AwsSolutionsChecks({ verbose: true }));
  template = Template.fromStack(stack);
});

afterAll(() => rmSync(outputDirectory, { recursive: true, force: true }));

describe('existing network and the CloudFront origin boundary', () => {
  it('places the ALB in the verified public subnets without creating VPC infrastructure', () => {
    for (const type of ['VPC', 'Subnet', 'NatGateway', 'Route', 'RouteTable', 'VPCEndpoint', 'InternetGateway']) {
      template.resourceCountIs(`AWS::EC2::${type}`, 0);
    }
    template.hasResourceProperties('AWS::ElasticLoadBalancingV2::LoadBalancer', {
      Scheme: 'internet-facing',
      Subnets: publicSubnets,
    });
    for (const [, resource] of resources('AWS::EC2::SecurityGroup')) {
      expect(resource.Properties.VpcId).toBe('vpc-0dfa5610180dfa628');
    }
  });

  it('admits only the CloudFront prefix list on ALB port 80 and the ALB on web port 8080', () => {
    const ingress = resources('AWS::EC2::SecurityGroupIngress').map(([, resource]) => resource.Properties);
    expect(ingress).toHaveLength(2);
    expect(ingress).toEqual(expect.arrayContaining([
      expect.objectContaining({ SourcePrefixListId: 'pl-22a6434b', IpProtocol: 'tcp', FromPort: 80, ToPort: 80 }),
      expect.objectContaining({ SourceSecurityGroupId: expect.any(Object), IpProtocol: 'tcp', FromPort: 8080, ToPort: 8080 }),
    ]));
    for (const rule of ingress) {
      expect(rule.CidrIp).toBeUndefined();
      expect(rule.CidrIpv6).toBeUndefined();
    }
    for (const [, group] of resources('AWS::EC2::SecurityGroup')) {
      expect(group.Properties.SecurityGroupIngress).toBeUndefined();
    }
    const albRule = ingress.find(rule => rule.SourcePrefixListId);
    const webRule = ingress.find(rule => rule.SourceSecurityGroupId);
    expect(webRule!.SourceSecurityGroupId).toEqual(albRule!.GroupId);
    const egress = resources('AWS::EC2::SecurityGroupEgress').map(([, resource]) => resource.Properties);
    expect(egress).toHaveLength(3);
    expect(egress).toContainEqual(expect.objectContaining({
      GroupId: albRule!.GroupId,
      DestinationSecurityGroupId: webRule!.GroupId,
      FromPort: 8080,
      ToPort: 8080,
    }));
    expect(egress.filter(rule => rule.CidrIp === '0.0.0.0/0')).toHaveLength(2);
    for (const rule of egress.filter(rule => rule.CidrIp)) {
      expect(rule).toMatchObject({ IpProtocol: 'tcp', FromPort: 443, ToPort: 443 });
    }
  });

  it('returns 403 unless the request has the Secrets Manager origin token used by CloudFront', () => {
    template.hasResourceProperties('AWS::ElasticLoadBalancingV2::Listener', {
      Port: 80,
      Protocol: 'HTTP',
      DefaultActions: [{ Type: 'fixed-response', FixedResponseConfig: { ContentType: 'text/plain', MessageBody: 'Forbidden', StatusCode: '403' } }],
    });
    template.hasResourceProperties('AWS::SecretsManager::Secret', {
      GenerateSecretString: { ExcludePunctuation: true, PasswordLength: 48 },
    });
    const [, rule] = resources('AWS::ElasticLoadBalancingV2::ListenerRule')[0]!;
    const header = rule.Properties.Conditions.find((condition: any) => condition.Field === 'http-header').HttpHeaderConfig;
    expect(rule.Properties.Actions[0].Type).toBe('forward');
    const [, distribution] = resources('AWS::CloudFront::Distribution')[0]!;
    const originHeader = distribution.Properties.DistributionConfig.Origins[0].OriginCustomHeaders[0];
    expect(originHeader.HeaderName).toBe(header.HttpHeaderName);
    expect(originHeader.HeaderValue).toEqual(header.Values[0]);
    expect(JSON.stringify(originHeader.HeaderValue)).toContain('{{resolve:secretsmanager:');
    expect(JSON.stringify(template.toJSON().Outputs)).not.toContain('{{resolve:secretsmanager:');
    for (const [, definition] of resources('AWS::ECS::TaskDefinition')) {
      expect(JSON.stringify(definition.Properties.ContainerDefinitions)).not.toContain('{{resolve:secretsmanager:');
    }
  });
});

describe('private Fargate runtime and storage isolation', () => {
  it('runs the read-only web task privately with rollback and a one-to-two task scaling range', () => {
    const [, definition] = task('web');
    expect(definition.Properties).toMatchObject({
      Cpu: '256',
      Memory: '512',
      NetworkMode: 'awsvpc',
      RuntimePlatform: { CpuArchitecture: 'ARM64', OperatingSystemFamily: 'LINUX' },
    });
    expect(definition.Properties.ContainerDefinitions[0]).toMatchObject({
      ReadonlyRootFilesystem: true,
      User: 'node',
      PortMappings: [{ ContainerPort: 8080, Protocol: 'tcp' }],
    });
    template.hasResourceProperties('AWS::ECS::Service', {
      DesiredCount: 1,
      EnableExecuteCommand: false,
      DeploymentConfiguration: {
        DeploymentCircuitBreaker: { Enable: true, Rollback: true },
        MinimumHealthyPercent: 100,
        MaximumPercent: 200,
      },
      NetworkConfiguration: { AwsvpcConfiguration: { AssignPublicIp: 'DISABLED', Subnets: privateSubnets } },
    });
    template.hasResourceProperties('AWS::ApplicationAutoScaling::ScalableTarget', { MinCapacity: 1, MaxCapacity: 2 });
    template.hasResourceProperties('AWS::ElasticLoadBalancingV2::TargetGroup', { HealthCheckPath: '/healthz', Port: 8080, TargetType: 'ip' });
  });

  it('waits for the web execution role policy throughout the service lifecycle', () => {
    const executionRoleId = task('web')[1].Properties.ExecutionRoleArn['Fn::GetAtt'][0];
    const executionPolicies = resources('AWS::IAM::Policy')
      .filter(([, resource]) => resource.Properties.Roles?.some((role: any) => role.Ref === executionRoleId))
      .map(([policyId]) => policyId);
    expect(executionPolicies).toHaveLength(1);
    for (const dependency of [executionRoleId, ...executionPolicies]) {
      template.hasResource('AWS::ECS::Service', {
        DependsOn: Match.arrayWith([dependency]),
      });
    }
  });

  it('uses the same ARM64 image for a separate collector task without inbound access', () => {
    const [, web] = task('web');
    const [, worker] = task('collector');
    expect(worker.Properties).toMatchObject({
      Cpu: '512',
      Memory: '1024',
      RuntimePlatform: { CpuArchitecture: 'ARM64', OperatingSystemFamily: 'LINUX' },
    });
    const collector = worker.Properties.ContainerDefinitions[0];
    expect(collector).toMatchObject({
      Name: 'collector',
      Command: ['node', 'dist/collector/run.js'],
      ReadonlyRootFilesystem: true,
      User: 'node',
      Image: web.Properties.ContainerDefinitions[0].Image,
    });
    expect(collector.PortMappings).toBeUndefined();
    expect(collector.Environment).toEqual(expect.arrayContaining([
      { Name: 'AWS_REGION', Value: 'ap-northeast-2' },
      { Name: 'BEDROCK_MODEL_ID', Value: 'global.anthropic.claude-haiku-5-5' },
      { Name: 'ENABLE_METRICS', Value: 'true' },
      expect.objectContaining({ Name: 'DATA_BUCKET' }),
    ]));
    expect(JSON.stringify(collector.Environment)).not.toContain('claude-haiku-4-5');
    expect(web.Properties.TaskRoleArn).not.toEqual(worker.Properties.TaskRoleArn);
    expect(web.Properties.ExecutionRoleArn).not.toEqual(worker.Properties.ExecutionRoleArn);
  });

  it.each(['web', 'collector'])('allows scoped GuardDuty image pulls only through the %s execution role', (containerName) => {
    const definition = task(containerName)[1].Properties;
    const statements = roleStatements(definition.ExecutionRoleArn).filter(statement => statement.Effect === 'Allow');
    const guardDutyRepositoryArn = 'arn:aws:ecr:ap-northeast-2:914738172881:repository/aws-guardduty-agent-fargate';
    const guardDutyGrant = statements.find(statement => (
      Array.isArray(statement.Resource) ? statement.Resource : [statement.Resource]
    ).includes(guardDutyRepositoryArn));
    expect(guardDutyGrant, `${containerName} execution role must pull the Seoul GuardDuty agent`).toBeDefined();
    expect([...actions(guardDutyGrant!)].sort()).toEqual([
      'ecr:BatchCheckLayerAvailability',
      'ecr:BatchGetImage',
      'ecr:GetDownloadUrlForLayer',
    ]);
    const authorization = statements.filter(statement => actions(statement).includes('ecr:GetAuthorizationToken'));
    expect(authorization).toHaveLength(1);
    expect(actions(authorization[0]!)).toEqual(['ecr:GetAuthorizationToken']);
    expect(authorization[0]!.Resource).toBe('*');
    for (const statement of statements.filter(statement => actions(statement).some(action => action.startsWith('ecr:')))) {
      if (statement === authorization[0]) continue;
      expect(JSON.stringify(statement.Resource)).not.toContain('*');
      expect(actions(statement)).not.toContain('ecr:*');
    }
    const executionRoleId = definition.ExecutionRoleArn['Fn::GetAtt'][0];
    expect(template.toJSON().Resources[executionRoleId].Properties.ManagedPolicyArns).toBeUndefined();
    expect(roleStatements(definition.TaskRoleArn).flatMap(actions).some(action => action.startsWith('ecr:'))).toBe(false);
  });

  it('retains encrypted, versioned, private data and expires raw history', () => {
    template.hasResource('AWS::S3::Bucket', {
      DeletionPolicy: 'Retain',
      UpdateReplacePolicy: 'Retain',
      Properties: {
        BucketEncryption: { ServerSideEncryptionConfiguration: [{ ServerSideEncryptionByDefault: { SSEAlgorithm: 'AES256' } }] },
        VersioningConfiguration: { Status: 'Enabled' },
        PublicAccessBlockConfiguration: {
          BlockPublicAcls: true,
          BlockPublicPolicy: true,
          IgnorePublicAcls: true,
          RestrictPublicBuckets: true,
        },
        LifecycleConfiguration: { Rules: Match.arrayWith([Match.objectLike({ Prefix: 'raw/', Status: 'Enabled', ExpirationInDays: 90, NoncurrentVersionExpiration: { NoncurrentDays: 30 } })]) },
      },
    });
    template.hasResourceProperties('AWS::S3::BucketPolicy', {
      PolicyDocument: { Statement: Match.arrayWith([Match.objectLike({ Effect: 'Deny', Condition: { Bool: { 'aws:SecureTransport': 'false' } } })]) },
    });
  });

  it('limits web writes to the presence table while keeping published content read-only', () => {
    const statements = roleStatements(task('web')[1].Properties.TaskRoleArn).filter(statement => statement.Effect === 'Allow');
    expect(statements.flatMap(actions).sort()).toEqual([
      'dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:Query', 'dynamodb:UpdateItem', 's3:GetObject',
    ]);
    const s3Statements = statements.filter(statement => actions(statement).some(action => action.startsWith('s3:')));
    expect(s3Statements).toHaveLength(1);
    expect(actions(s3Statements[0]!)).toEqual(['s3:GetObject']);
    expect(JSON.stringify(s3Statements[0]!.Resource)).toContain('/published/*');
    const [tableId] = resources('AWS::DynamoDB::Table')[0]!;
    const tableStatements = statements.filter(statement => actions(statement).some(action => action.startsWith('dynamodb:')));
    expect(tableStatements).toHaveLength(1);
    expect(tableStatements[0]!.Resource).toEqual({ 'Fn::GetAtt': [tableId, 'Arn'] });
    expect(statements.flatMap(actions)).not.toContain('dynamodb:TransactWriteItems');
    expect(JSON.stringify(statements)).not.toMatch(/bedrock:|s3:Put|s3:Delete|secretsmanager:|iam:/);
  });

  it('retains an encrypted on-demand presence table with composite keys, TTL and point-in-time recovery', () => {
    template.resourceCountIs('AWS::DynamoDB::Table', 1);
    template.hasResource('AWS::DynamoDB::Table', {
      DeletionPolicy: 'Retain',
      UpdateReplacePolicy: 'Retain',
      Properties: {
        AttributeDefinitions: [{ AttributeName: 'pk', AttributeType: 'S' }, { AttributeName: 'sk', AttributeType: 'S' }],
        KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }, { AttributeName: 'sk', KeyType: 'RANGE' }],
        BillingMode: 'PAY_PER_REQUEST',
        SSESpecification: { SSEEnabled: true },
        PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true },
        TimeToLiveSpecification: { AttributeName: 'expires_at', Enabled: true },
      },
    });
  });

  it('injects a retained presence secret and the public origin only into the web container', () => {
    const [, web] = task('web');
    const [, worker] = task('collector');
    const container = web.Properties.ContainerDefinitions[0];
    const injected = container.Secrets?.find((secret: any) => secret.Name === 'PRESENCE_SECRET');
    expect(injected, 'PRESENCE_SECRET injection').toBeDefined();
    const secretId = injected.ValueFrom.Ref;
    const secret = template.toJSON().Resources[secretId];
    expect(secret).toMatchObject({
      Type: 'AWS::SecretsManager::Secret',
      DeletionPolicy: 'Retain',
      UpdateReplacePolicy: 'Retain',
      Properties: { GenerateSecretString: { ExcludePunctuation: true, PasswordLength: 48 } },
    });
    const [tableId] = resources('AWS::DynamoDB::Table')[0]!;
    expect(container.Environment).toEqual(expect.arrayContaining([
      { Name: 'PRESENCE_TABLE', Value: { Ref: tableId } },
      { Name: 'PUBLIC_ORIGIN', Value: template.toJSON().Outputs.SiteUrl.Value },
    ]));
    expect(container.Environment.some((item: any) => item.Name === 'PRESENCE_SECRET')).toBe(false);
    const [, distribution] = resources('AWS::CloudFront::Distribution')[0]!;
    expect(JSON.stringify(distribution.Properties.DistributionConfig.Origins[0].OriginCustomHeaders)).not.toContain(secretId);
    const secretGrants = roleStatements(web.Properties.ExecutionRoleArn)
      .filter(statement => actions(statement).some(action => action.startsWith('secretsmanager:')));
    expect(secretGrants).toHaveLength(1);
    expect(actions(secretGrants[0]!)).toContain('secretsmanager:GetSecretValue');
    expect(secretGrants[0]!.Resource).toEqual({ Ref: secretId });
    expect(JSON.stringify(worker.Properties.ContainerDefinitions)).not.toMatch(/PRESENCE_TABLE|PRESENCE_SECRET|PUBLIC_ORIGIN/);
    for (const role of [worker.Properties.TaskRoleArn, worker.Properties.ExecutionRoleArn]) {
      expect(roleStatements(role).flatMap(actions).some(action => /^(?:dynamodb|secretsmanager):/.test(action))).toBe(false);
    }
  });

  it('limits the collector to the snapshot, raw writes and the requested Haiku 5.5 inference profile', () => {
    const statements = roleStatements(task('collector')[1].Properties.TaskRoleArn).filter(statement => statement.Effect === 'Allow');
    const s3Statements = statements.filter(statement => actions(statement).some(action => action.startsWith('s3:')));
    expect(s3Statements.flatMap(actions).sort()).toEqual(['s3:GetObject', 's3:ListBucket', 's3:PutObject', 's3:PutObject']);
    const snapshot = s3Statements.find(statement => actions(statement).includes('s3:GetObject'))!;
    expect(actions(snapshot).sort()).toEqual(['s3:GetObject', 's3:PutObject']);
    expect(JSON.stringify(snapshot.Resource)).toContain('/published/snapshot.json');
    const raw = s3Statements.find(statement => statement.Action === 's3:PutObject')!;
    expect(JSON.stringify(raw.Resource)).toContain('/raw/*');
    const listBucket = s3Statements.find(statement => statement.Action === 's3:ListBucket')!;
    const [bucketId] = resources('AWS::S3::Bucket')[0]!;
    expect(listBucket.Resource).toEqual({ 'Fn::GetAtt': [bucketId, 'Arn'] });
    const modelStatements = statements.filter(statement => actions(statement).some(action => action.startsWith('bedrock:')));
    expect(modelStatements).toHaveLength(2);
    for (const statement of modelStatements) expect(actions(statement)).toEqual(['bedrock:InvokeModel']);
    const inferenceProfile = modelStatements.find(statement => JSON.stringify(statement.Resource).includes('inference-profile/'))!;
    expect(JSON.stringify(inferenceProfile.Resource))
      .toContain(':bedrock:ap-northeast-2:061525506239:inference-profile/global.anthropic.claude-haiku-5-5');
    expect(JSON.stringify(inferenceProfile.Resource)).not.toContain('*');
    expect(Array.isArray(inferenceProfile.Resource)).toBe(false);
    const foundationModel = modelStatements.find(statement => JSON.stringify(statement.Resource).includes('foundation-model/'))!;
    expect(JSON.stringify(foundationModel.Resource)).toContain(':bedrock:*::foundation-model/anthropic.claude-haiku-5-5');
    expect(JSON.stringify(foundationModel.Resource)).not.toContain('foundation-model/*');
    expect(Array.isArray(foundationModel.Resource)).toBe(false);
    expect(foundationModel.Condition).toEqual({
      StringEquals: { 'bedrock:InferenceProfileArn': inferenceProfile.Resource },
    });
    expect(JSON.stringify(modelStatements)).not.toContain('claude-haiku-4-5');
  });
});

describe('scheduled collection and monitoring', () => {
  it('runs one private worker at 09:00 Seoul with retries and a dead letter queue', () => {
    const [workerId] = task('collector');
    template.hasResourceProperties('AWS::Scheduler::Schedule', {
      ScheduleExpression: 'cron(0 9 * * ? *)',
      ScheduleExpressionTimezone: 'Asia/Seoul',
      FlexibleTimeWindow: { Mode: 'OFF' },
      State: 'ENABLED',
      Target: {
        EcsParameters: {
          TaskDefinitionArn: { Ref: workerId },
          LaunchType: 'FARGATE',
          PlatformVersion: '1.4.0',
          TaskCount: 1,
          EnableExecuteCommand: false,
          NetworkConfiguration: { AwsvpcConfiguration: { AssignPublicIp: 'DISABLED', Subnets: privateSubnets } },
        },
        RetryPolicy: { MaximumEventAgeInSeconds: 3600, MaximumRetryAttempts: 2 },
        DeadLetterConfig: { Arn: Match.anyValue() },
      },
    });
    const [, schedule] = resources('AWS::Scheduler::Schedule')[0]!;
    const workerSecurityGroup = schedule.Properties.Target.EcsParameters.NetworkConfiguration.AwsvpcConfiguration.SecurityGroups[0];
    const ingress = resources('AWS::EC2::SecurityGroupIngress');
    expect(ingress.some(([, rule]) => JSON.stringify(rule.Properties.GroupId) === JSON.stringify(workerSecurityGroup))).toBe(false);
  });

  it('allows the scheduler to run only this worker and pass only its task and execution roles', () => {
    const [workerId, worker] = task('collector');
    const [, schedule] = resources('AWS::Scheduler::Schedule')[0]!;
    const statements = roleStatements(schedule.Properties.Target.RoleArn);
    const runTask = statements.find(statement => actions(statement).includes('ecs:RunTask'))!;
    expect(runTask.Resource).toEqual({ Ref: workerId });
    expect(runTask.Condition).toMatchObject({ ArnEquals: { 'ecs:cluster': expect.anything() } });
    const passRole = statements.find(statement => actions(statement).includes('iam:PassRole'))!;
    expect(passRole.Resource).toEqual([worker.Properties.TaskRoleArn, worker.Properties.ExecutionRoleArn]);
    expect(passRole.Condition).toEqual({ StringEquals: { 'iam:PassedToService': 'ecs-tasks.amazonaws.com' } });
    const roleId = schedule.Properties.Target.RoleArn['Fn::GetAtt'][0];
    const role = template.toJSON().Resources[roleId];
    expect(role.Properties.AssumeRolePolicyDocument.Statement[0]).toMatchObject({
      Principal: { Service: 'scheduler.amazonaws.com' },
      Condition: { StringEquals: { 'aws:SourceAccount': '061525506239' }, ArnEquals: { 'aws:SourceArn': expect.anything() } },
    });
  });

  it('enforces TLS on the encrypted dead letter queue', () => {
    template.hasResourceProperties('AWS::SQS::Queue', { SqsManagedSseEnabled: true, MessageRetentionPeriod: 1209600 });
    template.hasResourceProperties('AWS::SQS::QueuePolicy', {
      PolicyDocument: { Statement: Match.arrayWith([Match.objectLike({
        Effect: 'Deny', Action: 'sqs:*', Condition: { Bool: { 'aws:SecureTransport': 'false' } },
      })]) },
    });
  });

  it('keeps logs for 14 days and alarms on collection failure, unhealthy targets, 5xx and DLQ messages', () => {
    const logGroups = resources('AWS::Logs::LogGroup');
    expect(logGroups).toHaveLength(2);
    for (const [, log] of logGroups) expect(log.Properties.RetentionInDays).toBe(14);
    template.hasResourceProperties('AWS::CloudWatch::Alarm', {
      Namespace: 'CodePulse',
      MetricName: 'CollectionFailure',
      Dimensions: [{ Name: 'Application', Value: 'code-pulse' }],
      ComparisonOperator: 'GreaterThanOrEqualToThreshold',
      Threshold: 1,
      TreatMissingData: 'notBreaching',
    });
    for (const metricName of ['HTTPCode_ELB_5XX_Count', 'HTTPCode_Target_5XX_Count', 'HealthyHostCount', 'ApproximateNumberOfMessagesVisible']) {
      template.hasResourceProperties('AWS::CloudWatch::Alarm', { MetricName: metricName });
    }
    template.resourceCountIs('AWS::SNS::Topic', 0);
  });

  it('evaluates only the completed UTC day when daily collection success is missing', () => {
    template.hasResourceProperties('AWS::CloudWatch::Alarm', {
      Namespace: 'CodePulse',
      MetricName: 'CollectionSuccess',
      Dimensions: [{ Name: 'Application', Value: 'code-pulse' }],
      Period: 86400,
      EvaluationPeriods: 1,
      EvaluationWindow: { WallClockWindow: { Timezone: 'UTC' } },
      Statistic: 'Sum',
      ComparisonOperator: 'LessThanThreshold',
      Threshold: 1,
      TreatMissingData: 'breaching',
    });
  });
});

describe('edge caching and operational outputs', () => {
  it('serves the exact custom hostname with the issued US East certificate and canonical application URLs', () => {
    const [, distribution] = resources('AWS::CloudFront::Distribution')[0]!;
    expect(distribution.Properties.DistributionConfig).toMatchObject({
      Aliases: ['code-pulse.whchoi.net'],
      ViewerCertificate: {
        AcmCertificateArn: 'arn:aws:acm:us-east-1:061525506239:certificate/7d53182a-2a2a-4225-a319-4f94030561b7',
        MinimumProtocolVersion: 'TLSv1.2_2021',
        SslSupportMethod: 'sni-only',
      },
    });
    template.resourceCountIs('AWS::CertificateManager::Certificate', 0);
    expect(template.toJSON().Outputs.SiteUrl.Value).toBe('https://code-pulse.whchoi.net');
    for (const containerName of ['web', 'collector']) {
      expect(task(containerName)[1].Properties.ContainerDefinitions[0].Environment).toContainEqual({
        Name: 'PUBLIC_BASE_URL', Value: 'https://code-pulse.whchoi.net',
      });
    }
    expect(task('web')[1].Properties.ContainerDefinitions[0].Environment).toContainEqual({
      Name: 'PUBLIC_ORIGIN', Value: 'https://code-pulse.whchoi.net',
    });
  });

  it('redirects alternate hosts before caching and preserves encoded queries and repeated values', () => {
    const functions = resources('AWS::CloudFront::Function');
    expect(functions).toHaveLength(1);
    const [functionId, redirect] = functions[0]!;
    expect(redirect.Properties.AutoPublish).toBe(true);
    const [, distribution] = resources('AWS::CloudFront::Distribution')[0]!;
    const config = distribution.Properties.DistributionConfig;
    for (const behavior of [config.DefaultCacheBehavior, ...config.CacheBehaviors]) {
      expect(behavior.FunctionAssociations).toEqual([{
        EventType: 'viewer-request', FunctionARN: { 'Fn::GetAtt': [functionId, 'FunctionARN'] },
      }]);
    }
    const handler = runInNewContext(`${redirect.Properties.FunctionCode}\nhandler;`);
    const request = {
      method: 'GET',
      uri: '/changes/claude-code-2.1.42',
      headers: { host: { value: 'dxdh24n4uucjz.cloudfront.net' } },
      querystring: {
        product: { value: 'claude-code' },
        q: { value: '%ED%95%9C%EA%B8%80%20%26%20a%2Bb' },
        tag: { value: 'one', multiValue: [{ value: 'one' }, { value: 'two%2Fthree' }] },
        empty: { value: '' },
      },
    };
    const response = handler({ request });
    expect(response.statusCode).toBe(308);
    expect(response.headers.location.value).toBe(
      'https://code-pulse.whchoi.net/changes/claude-code-2.1.42?product=claude-code&q=%ED%95%9C%EA%B8%80%20%26%20a%2Bb&tag=one&tag=two%2Fthree&empty=',
    );
    const head = handler({ request: { ...request, method: 'HEAD', uri: '/feed.xml', querystring: {} } });
    expect(head.statusCode).toBe(308);
    expect(head.headers.location.value).toBe('https://code-pulse.whchoi.net/feed.xml');
  });

  it('keeps canonical requests and non-read requests on the normal origin-check path', () => {
    const functions = resources('AWS::CloudFront::Function');
    expect(functions).toHaveLength(1);
    const handler = runInNewContext(`${functions[0]![1].Properties.FunctionCode}\nhandler;`);
    const canonical = {
      method: 'GET', uri: '/', querystring: {},
      headers: { host: { value: 'code-pulse.whchoi.net' } },
    };
    expect(handler({ request: canonical })).toBe(canonical);
    const post = {
      ...canonical, method: 'POST', uri: '/api/presence',
      headers: { host: { value: 'dxdh24n4uucjz.cloudfront.net' }, origin: { value: 'https://dxdh24n4uucjz.cloudfront.net' } },
    };
    expect(handler({ request: post })).toBe(post);
  });

  it('creates only one custom cache policy within the available quota', () => {
    template.resourceCountIs('AWS::CloudFront::CachePolicy', 1);
  });

  it('shares the custom policy between HTML and API with origin-controlled caching capped at 60 seconds', () => {
    const [, distribution] = resources('AWS::CloudFront::Distribution')[0]!;
    const config = distribution.Properties.DistributionConfig;
    const api = config.CacheBehaviors.find((behavior: any) => behavior.PathPattern === '/api/*');
    expect(api.CachePolicyId).toEqual(config.DefaultCacheBehavior.CachePolicyId);
    const sharedPolicyId = config.DefaultCacheBehavior.CachePolicyId.Ref;
    expect(sharedPolicyId).toBeDefined();
    const sharedPolicy = template.toJSON().Resources[sharedPolicyId];
    expect(sharedPolicy.Type).toBe('AWS::CloudFront::CachePolicy');
    expect(sharedPolicy.Properties.CachePolicyConfig).toMatchObject({
      MinTTL: 0,
      DefaultTTL: 0,
      MaxTTL: 60,
      ParametersInCacheKeyAndForwardedToOrigin: {
        CookiesConfig: { CookieBehavior: 'none' },
        HeadersConfig: { HeaderBehavior: 'none' },
        QueryStringsConfig: { QueryStringBehavior: 'all' },
        EnableAcceptEncodingGzip: true,
        EnableAcceptEncodingBrotli: true,
      },
    });
  });

  it('redirects viewers to HTTPS, limits API cache to 60 seconds and preserves errors', () => {
    expect(resources('AWS::CloudFront::Distribution')).toHaveLength(1);
    const [, distribution] = resources('AWS::CloudFront::Distribution')[0]!;
    const config = distribution.Properties.DistributionConfig;
    expect(config.DefaultCacheBehavior.ViewerProtocolPolicy).toBe('redirect-to-https');
    expect(config.Origins[0].CustomOriginConfig.OriginProtocolPolicy).toBe('http-only');
    const api = config.CacheBehaviors.find((behavior: any) => behavior.PathPattern === '/api/*');
    expect(api.AllowedMethods).toEqual(['GET', 'HEAD']);
    const cachePolicy = template.toJSON().Resources[api.CachePolicyId.Ref].Properties.CachePolicyConfig;
    expect(cachePolicy).toMatchObject({ MinTTL: 0, DefaultTTL: 0, MaxTTL: 60 });
    for (const path of ['/assets/*', '/fonts/*']) {
      expect(config.CacheBehaviors.find((behavior: any) => behavior.PathPattern === path).CachePolicyId)
        .toBe('658327ea-f89d-4fab-a63d-7e88639e58f6');
    }
    for (const response of config.CustomErrorResponses) {
      expect(response.ResponseCode).toBeUndefined();
      expect(response.ResponsePagePath).toBeUndefined();
      expect(response.ErrorCachingMinTTL).toBe(0);
    }
    for (const [, policy] of resources('AWS::CloudFront::ResponseHeadersPolicy')) {
      expect(policy.Properties.ResponseHeadersPolicyConfig.SecurityHeadersConfig.ContentSecurityPolicy).toBeUndefined();
    }
  });

  it('routes only the exact presence endpoint through uncached viewer headers and cookies before the read-only API behavior', () => {
    const [, distribution] = resources('AWS::CloudFront::Distribution')[0]!;
    const behaviors = distribution.Properties.DistributionConfig.CacheBehaviors;
    const index = behaviors.findIndex((behavior: any) => behavior.PathPattern === '/api/presence');
    const apiIndex = behaviors.findIndex((behavior: any) => behavior.PathPattern === '/api/*');
    expect(index).toBeGreaterThanOrEqual(0);
    expect(index).toBeLessThan(apiIndex);
    const presence = behaviors[index];
    expect(presence).toMatchObject({
      ViewerProtocolPolicy: 'redirect-to-https',
      CachePolicyId: '4135ea2d-6df8-44a3-9df3-4b5a84be39ad',
      OriginRequestPolicyId: '216adef6-5c7f-47e4-b989-5492eafa07d3',
      Compress: false,
    });
    expect([...presence.AllowedMethods].sort()).toEqual(['DELETE', 'GET', 'HEAD', 'OPTIONS', 'PATCH', 'POST', 'PUT']);
    expect(behaviors[apiIndex].AllowedMethods).toEqual(['GET', 'HEAD']);
    template.resourceCountIs('AWS::CloudFront::CachePolicy', 1);
    template.resourceCountIs('AWS::CloudFront::OriginRequestPolicy', 0);
  });

  it('exports every identifier needed for deployment verification and manual collection', () => {
    const outputs = template.toJSON().Outputs ?? {};
    for (const name of ['SiteUrl', 'DistributionId', 'DistributionDomainName', 'AlbDnsName', 'ClusterName', 'ServiceName',
      'WorkerTaskDefinitionArn', 'WorkerSecurityGroupId', 'PrivateSubnetIds', 'DataBucketName', 'ScheduleName',
      'WebLogGroupName', 'CollectorLogGroupName', 'PresenceTableName']) {
      expect(outputs[name], name).toBeDefined();
    }
    expect(outputs.PrivateSubnetIds.Value).toBe(privateSubnets.join(','));
    expect(JSON.stringify(outputs.SiteUrl.Value)).toContain('https://');
  });

  it('passes AwsSolutionsChecks with resource-specific, documented exceptions', () => {
    expect(Annotations.fromStack(stack).findError('*', Match.anyValue())).toEqual([]);
    expect(Annotations.fromStack(stack).findWarning('*', Match.anyValue())).toEqual([]);
  });
});

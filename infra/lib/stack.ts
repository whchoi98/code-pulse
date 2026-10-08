import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CfnOutput, Duration, IgnoreMode, RemovalPolicy, Stack, Tags, type StackProps } from 'aws-cdk-lib';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecrAssets from 'aws-cdk-lib/aws-ecr-assets';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as scheduler from 'aws-cdk-lib/aws-scheduler';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import { Construct } from 'constructs';
import { NagSuppressions } from 'cdk-nag';

const APP_PORT = 8080;
const ORIGIN_HEADER = 'X-Code-Pulse-Origin';
const PUBLIC_DOMAIN = 'code-pulse.whchoi.net';
const CERTIFICATE_ARN = 'arn:aws:acm:us-east-1:061525506239:certificate/7d53182a-2a2a-4225-a319-4f94030561b7';
const MODEL_ID = 'global.anthropic.claude-haiku-5-5';
const FOUNDATION_MODEL_ID = 'anthropic.claude-haiku-5-5';
const GUARDDUTY_REPOSITORY_ARN = 'arn:aws:ecr:ap-northeast-2:914738172881:repository/aws-guardduty-agent-fargate';
const PUBLIC_SUBNET_IDS = ['subnet-08486a1e618b1991e', 'subnet-0c161777c4031c320'];
const PRIVATE_SUBNET_IDS = ['subnet-07b1e65682847dce9', 'subnet-095297380cd45e1eb'];

export class CodePulseStack extends Stack {
  constructor(scope: Construct, id: string, props: StackProps) {
    super(scope, id, props);
    Tags.of(this).add('Application', 'code-pulse');

    // These identifiers were verified with AWS before implementation. Importing
    // attributes avoids lookups and cannot create or mutate the shared network.
    const vpc = ec2.Vpc.fromVpcAttributes(this, 'ExistingVpc', {
      vpcId: 'vpc-0dfa5610180dfa628',
      vpcCidrBlock: '10.100.0.0/16',
      availabilityZones: ['ap-northeast-2a', 'ap-northeast-2b'],
      publicSubnetIds: PUBLIC_SUBNET_IDS,
      publicSubnetRouteTableIds: ['rtb-01d918b95384379e7', 'rtb-032d073e28d5a0afd'],
      privateSubnetIds: PRIVATE_SUBNET_IDS,
      privateSubnetRouteTableIds: ['rtb-0cc7d19bb484c49ef', 'rtb-021c674ad5e43276f'],
    });
    const privateSubnets = { subnets: vpc.privateSubnets };
    const albSecurityGroup = new ec2.SecurityGroup(this, 'AlbSecurityGroup', {
      vpc,
      description: 'CloudFront origin-facing prefix list to ALB HTTP only',
      allowAllOutbound: false,
      disableInlineRules: true,
    });
    const webSecurityGroup = new ec2.SecurityGroup(this, 'WebSecurityGroup', {
      vpc,
      description: 'ALB to private web task; HTTPS egress for AWS APIs',
      allowAllOutbound: false,
      disableInlineRules: true,
    });
    const workerSecurityGroup = new ec2.SecurityGroup(this, 'WorkerSecurityGroup', {
      vpc,
      description: 'Private collector with no inbound access and HTTPS egress only',
      allowAllOutbound: false,
      disableInlineRules: true,
    });
    albSecurityGroup.addIngressRule(ec2.Peer.prefixList('pl-22a6434b'), ec2.Port.tcp(80), 'CloudFront origin-facing');
    albSecurityGroup.addEgressRule(webSecurityGroup, ec2.Port.tcp(APP_PORT), 'ALB requests and health checks');
    webSecurityGroup.addIngressRule(albSecurityGroup, ec2.Port.tcp(APP_PORT), 'ALB requests and health checks');
    webSecurityGroup.addEgressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(443), 'Read published snapshots through HTTPS');
    workerSecurityGroup.addEgressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(443), 'Official sources and AWS APIs through HTTPS');

    const dataBucket = new s3.Bucket(this, 'DataBucket', {
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED,
      enforceSSL: true,
      versioned: true,
      removalPolicy: RemovalPolicy.RETAIN,
      lifecycleRules: [
        { id: 'RawHistory', prefix: 'raw/', expiration: Duration.days(90), noncurrentVersionExpiration: Duration.days(30) },
        { id: 'OldSnapshots', prefix: 'published/', noncurrentVersionExpiration: Duration.days(30) },
        { id: 'IncompleteUploads', abortIncompleteMultipartUploadAfter: Duration.days(1) },
      ],
    });
    const presenceTable = new dynamodb.Table(this, 'PresenceTable', {
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
      timeToLiveAttribute: 'expires_at',
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      removalPolicy: RemovalPolicy.RETAIN,
    });
    const presenceSecret = new secretsmanager.Secret(this, 'PresenceSecret', {
      description: 'Code Pulse stable anonymous browser presence signing secret',
      generateSecretString: { excludePunctuation: true, passwordLength: 48 },
      removalPolicy: RemovalPolicy.RETAIN,
    });
    const originToken = new secretsmanager.Secret(this, 'OriginToken', {
      description: 'Code Pulse CloudFront to ALB origin verification token',
      generateSecretString: { excludePunctuation: true, passwordLength: 48 },
      removalPolicy: RemovalPolicy.RETAIN,
    });
    // The value remains a Secrets Manager dynamic reference in the template.
    // Neither task receives the token or permission to retrieve it.
    const originTokenValue = originToken.secretValue.unsafeUnwrap();
    const loadBalancer = new elbv2.ApplicationLoadBalancer(this, 'Alb', {
      vpc,
      vpcSubnets: { subnets: vpc.publicSubnets },
      internetFacing: true,
      securityGroup: albSecurityGroup,
      idleTimeout: Duration.seconds(60),
      dropInvalidHeaderFields: true,
    });
    const targetGroup = new elbv2.ApplicationTargetGroup(this, 'WebTargetGroup', {
      vpc,
      port: APP_PORT,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targetType: elbv2.TargetType.IP,
      deregistrationDelay: Duration.seconds(30),
      healthCheck: {
        path: '/healthz',
        healthyHttpCodes: '200',
        interval: Duration.seconds(30),
        timeout: Duration.seconds(5),
        healthyThresholdCount: 2,
        unhealthyThresholdCount: 3,
      },
    });
    const listener = loadBalancer.addListener('Http', {
      port: 80,
      protocol: elbv2.ApplicationProtocol.HTTP,
      open: false,
      defaultAction: elbv2.ListenerAction.fixedResponse(403, { contentType: 'text/plain', messageBody: 'Forbidden' }),
    });
    listener.addAction('VerifiedOrigin', {
      priority: 1,
      conditions: [elbv2.ListenerCondition.httpHeader(ORIGIN_HEADER, [originTokenValue])],
      action: elbv2.ListenerAction.forward([targetGroup]),
    });

    const origin = new origins.HttpOrigin(loadBalancer.loadBalancerDnsName, {
      protocolPolicy: cloudfront.OriginProtocolPolicy.HTTP_ONLY,
      customHeaders: { [ORIGIN_HEADER]: originTokenValue },
      readTimeout: Duration.seconds(30),
      keepaliveTimeout: Duration.seconds(30),
    });
    const securityHeaders = new cloudfront.ResponseHeadersPolicy(this, 'SecurityHeaders', {
      comment: 'Code Pulse security headers; the application owns its CSP',
      securityHeadersBehavior: {
        contentTypeOptions: { override: true },
        frameOptions: { frameOption: cloudfront.HeadersFrameOption.DENY, override: true },
        referrerPolicy: { referrerPolicy: cloudfront.HeadersReferrerPolicy.STRICT_ORIGIN_WHEN_CROSS_ORIGIN, override: true },
        strictTransportSecurity: { accessControlMaxAge: Duration.days(365), includeSubdomains: true, override: true },
      },
    });
    // Preserve the existing logical ID and use one custom policy for HTML and API.
    const sharedCache = new cloudfront.CachePolicy(this, 'HtmlCache', {
      comment: 'HTML and public API; honour origin Cache-Control up to 60 seconds',
      minTtl: Duration.seconds(0),
      defaultTtl: Duration.seconds(0),
      maxTtl: Duration.seconds(60),
      cookieBehavior: cloudfront.CacheCookieBehavior.none(),
      headerBehavior: cloudfront.CacheHeaderBehavior.none(),
      queryStringBehavior: cloudfront.CacheQueryStringBehavior.all(),
      enableAcceptEncodingGzip: true,
      enableAcceptEncodingBrotli: true,
    });
    const canonicalHost = new cloudfront.Function(this, 'CanonicalHost', {
      comment: 'Preserve shared links while moving readers to the public hostname',
      runtime: cloudfront.FunctionRuntime.JS_2_0,
      code: cloudfront.FunctionCode.fromInline(`function handler(event) {
  var request = event.request;
  if (request.headers.host.value.toLowerCase() === '${PUBLIC_DOMAIN}' ||
      (request.method !== 'GET' && request.method !== 'HEAD')) return request;
  var query = [];
  Object.keys(request.querystring).forEach(function (key) {
    var parameter = request.querystring[key];
    (parameter.multiValue || [parameter]).forEach(function (item) {
      query.push(key + '=' + item.value);
    });
  });
  return {
    statusCode: 308,
    statusDescription: 'Permanent Redirect',
    headers: {
      location: { value: 'https://${PUBLIC_DOMAIN}' + request.uri + (query.length ? '?' + query.join('&') : '') },
      'cache-control': { value: 'public, max-age=300' }
    }
  };
}`),
    });
    const publicBehavior = {
      origin,
      viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
      allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
      responseHeadersPolicy: securityHeaders,
      functionAssociations: [{ function: canonicalHost, eventType: cloudfront.FunctionEventType.VIEWER_REQUEST }],
      compress: true,
    };
    const distribution = new cloudfront.Distribution(this, 'Distribution', {
      comment: 'Code Pulse official changelog briefings',
      domainNames: [PUBLIC_DOMAIN],
      certificate: acm.Certificate.fromCertificateArn(this, 'PublicCertificate', CERTIFICATE_ARN),
      minimumProtocolVersion: cloudfront.SecurityPolicyProtocol.TLS_V1_2_2021,
      defaultBehavior: { ...publicBehavior, cachePolicy: sharedCache },
      additionalBehaviors: {
        '/api/presence': {
          ...publicBehavior,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
          cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
          originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER,
          compress: false,
        },
        '/api/*': { ...publicBehavior, cachePolicy: sharedCache },
        '/assets/*': { ...publicBehavior, cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED },
        '/fonts/*': { ...publicBehavior, cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED },
        '/healthz': { ...publicBehavior, cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED, compress: false },
      },
      errorResponses: [400, 403, 404, 500, 502, 503, 504].map(httpStatus => ({ httpStatus, ttl: Duration.seconds(0) })),
      httpVersion: cloudfront.HttpVersion.HTTP2_AND_3,
      enableIpv6: true,
      priceClass: cloudfront.PriceClass.PRICE_CLASS_200,
    });
    const siteUrl = `https://${PUBLIC_DOMAIN}`;

    const projectDirectory = fileURLToPath(new URL('../../', import.meta.url));
    const image = new ecrAssets.DockerImageAsset(this, 'Image', {
      directory: projectDirectory,
      file: 'Dockerfile',
      platform: ecrAssets.Platform.LINUX_ARM64,
      ignoreMode: IgnoreMode.DOCKER,
      exclude: readFileSync(join(projectDirectory, '.dockerignore'), 'utf8').split(/\r?\n/).filter(line => line && !line.startsWith('#')),
    });
    const cluster = new ecs.Cluster(this, 'Cluster', {
      vpc,
      containerInsightsV2: ecs.ContainerInsights.ENABLED,
    });
    const webLogs = new logs.LogGroup(this, 'WebLogs', {
      retention: logs.RetentionDays.TWO_WEEKS,
      removalPolicy: RemovalPolicy.RETAIN,
    });
    const collectorLogs = new logs.LogGroup(this, 'CollectorLogs', {
      retention: logs.RetentionDays.TWO_WEEKS,
      removalPolicy: RemovalPolicy.RETAIN,
    });
    const webTaskRole = new iam.Role(this, 'WebTaskRole', { assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com') });
    const webExecutionRole = new iam.Role(this, 'WebExecutionRole', { assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com') });
    const workerTaskRole = new iam.Role(this, 'WorkerTaskRole', { assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com') });
    const workerExecutionRole = new iam.Role(this, 'WorkerExecutionRole', { assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com') });
    // Account-managed GuardDuty injects its agent into both Fargate workloads.
    for (const executionRole of [webExecutionRole, workerExecutionRole]) {
      executionRole.addToPolicy(new iam.PolicyStatement({
        actions: ['ecr:BatchCheckLayerAvailability', 'ecr:GetDownloadUrlForLayer', 'ecr:BatchGetImage'],
        resources: [GUARDDUTY_REPOSITORY_ARN],
      }));
    }
    webTaskRole.addToPolicy(new iam.PolicyStatement({
      actions: ['s3:GetObject'],
      resources: [dataBucket.arnForObjects('published/*')],
    }));
    // Transactional Put/Update operations use the underlying item permissions.
    webTaskRole.addToPolicy(new iam.PolicyStatement({
      actions: ['dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:Query', 'dynamodb:UpdateItem'],
      resources: [presenceTable.tableArn],
    }));
    workerTaskRole.addToPolicy(new iam.PolicyStatement({
      actions: ['s3:GetObject', 's3:PutObject'],
      resources: [dataBucket.arnForObjects('published/snapshot.json')],
    }));
    workerTaskRole.addToPolicy(new iam.PolicyStatement({
      actions: ['s3:PutObject'],
      resources: [dataBucket.arnForObjects('raw/*')],
    }));
    // GetObject on an absent snapshot returns NoSuchKey only when ListBucket is
    // allowed. This lets the collector initialize a newly created empty bucket.
    workerTaskRole.addToPolicy(new iam.PolicyStatement({
      actions: ['s3:ListBucket'],
      resources: [dataBucket.bucketArn],
    }));
    const inferenceProfileArn = this.formatArn({
      service: 'bedrock', resource: 'inference-profile', resourceName: MODEL_ID,
    });
    workerTaskRole.addToPolicy(new iam.PolicyStatement({
      actions: ['bedrock:InvokeModel'],
      resources: [inferenceProfileArn],
    }));
    workerTaskRole.addToPolicy(new iam.PolicyStatement({
      actions: ['bedrock:InvokeModel'],
      resources: [`arn:${this.partition}:bedrock:*::foundation-model/${FOUNDATION_MODEL_ID}`],
      conditions: { StringEquals: { 'bedrock:InferenceProfileArn': inferenceProfileArn } },
    }));

    const runtimePlatform = { cpuArchitecture: ecs.CpuArchitecture.ARM64, operatingSystemFamily: ecs.OperatingSystemFamily.LINUX };
    const webTask = new ecs.FargateTaskDefinition(this, 'WebTask', {
      cpu: 256,
      memoryLimitMiB: 512,
      runtimePlatform,
      taskRole: webTaskRole,
      executionRole: webExecutionRole,
    });
    webTask.addContainer('web', {
      containerName: 'web',
      image: ecs.ContainerImage.fromDockerImageAsset(image),
      user: 'node',
      readonlyRootFilesystem: true,
      portMappings: [{ containerPort: APP_PORT, protocol: ecs.Protocol.TCP }],
      logging: ecs.LogDrivers.awsLogs({ logGroup: webLogs, streamPrefix: 'web' }),
      environment: {
        NODE_ENV: 'production',
        PORT: String(APP_PORT),
        STATIC_DIR: '/app/dist/public',
        DATA_BUCKET: dataBucket.bucketName,
        AWS_REGION: this.region,
        PUBLIC_BASE_URL: siteUrl,
        PUBLIC_ORIGIN: siteUrl,
        PRESENCE_TABLE: presenceTable.tableName,
      },
      secrets: { PRESENCE_SECRET: ecs.Secret.fromSecretsManager(presenceSecret) },
    });
    const webService = new ecs.FargateService(this, 'WebService', {
      cluster,
      taskDefinition: webTask,
      desiredCount: 1,
      minHealthyPercent: 100,
      maxHealthyPercent: 200,
      circuitBreaker: { enable: true, rollback: true },
      healthCheckGracePeriod: Duration.seconds(60),
      vpcSubnets: privateSubnets,
      assignPublicIp: false,
      securityGroups: [webSecurityGroup],
      enableExecuteCommand: false,
      platformVersion: ecs.FargatePlatformVersion.VERSION1_4,
    });
    // Keep image pull and log permissions available for the service lifecycle.
    webService.node.addDependency(webExecutionRole);
    webService.attachToApplicationTargetGroup(targetGroup);
    const scaling = webService.autoScaleTaskCount({ minCapacity: 1, maxCapacity: 2 });
    scaling.scaleOnCpuUtilization('Cpu', {
      targetUtilizationPercent: 60,
      scaleOutCooldown: Duration.seconds(60),
      scaleInCooldown: Duration.minutes(5),
    });

    const workerTask = new ecs.FargateTaskDefinition(this, 'WorkerTask', {
      cpu: 512,
      memoryLimitMiB: 1024,
      runtimePlatform,
      taskRole: workerTaskRole,
      executionRole: workerExecutionRole,
    });
    workerTask.addContainer('collector', {
      containerName: 'collector',
      image: ecs.ContainerImage.fromDockerImageAsset(image),
      command: ['node', 'dist/collector/run.js'],
      user: 'node',
      readonlyRootFilesystem: true,
      logging: ecs.LogDrivers.awsLogs({ logGroup: collectorLogs, streamPrefix: 'collector' }),
      environment: {
        NODE_ENV: 'production',
        DATA_BUCKET: dataBucket.bucketName,
        AWS_REGION: this.region,
        BEDROCK_MODEL_ID: MODEL_ID,
        ENABLE_METRICS: 'true',
        PUBLIC_BASE_URL: siteUrl,
      },
    });

    const deadLetterQueue = new sqs.Queue(this, 'SchedulerDeadLetterQueue', {
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      enforceSSL: true,
      retentionPeriod: Duration.days(14),
      removalPolicy: RemovalPolicy.RETAIN,
    });
    const scheduleGroup = new scheduler.CfnScheduleGroup(this, 'ScheduleGroup', { name: 'code-pulse' });
    // Scheduler's confused-deputy source ARN is the schedule group, not a
    // schedule ARN. Keep trust and RunTask permissions at that exact scope.
    const schedulerRole = new iam.Role(this, 'SchedulerRole', {
      assumedBy: new iam.ServicePrincipal('scheduler.amazonaws.com', {
        conditions: { StringEquals: { 'aws:SourceAccount': this.account }, ArnEquals: { 'aws:SourceArn': scheduleGroup.attrArn } },
      }),
    });
    schedulerRole.addToPolicy(new iam.PolicyStatement({
      actions: ['ecs:RunTask'],
      resources: [workerTask.taskDefinitionArn],
      conditions: { ArnEquals: { 'ecs:cluster': cluster.clusterArn } },
    }));
    schedulerRole.addToPolicy(new iam.PolicyStatement({
      actions: ['iam:PassRole'],
      resources: [workerTaskRole.roleArn, workerExecutionRole.roleArn],
      conditions: { StringEquals: { 'iam:PassedToService': 'ecs-tasks.amazonaws.com' } },
    }));
    schedulerRole.addToPolicy(new iam.PolicyStatement({ actions: ['sqs:SendMessage'], resources: [deadLetterQueue.queueArn] }));
    const dailySchedule = new scheduler.CfnSchedule(this, 'DailyCollection', {
      name: 'code-pulse-daily',
      groupName: scheduleGroup.ref,
      description: 'Collect official coding assistant changes every day at 09:00 Seoul',
      scheduleExpression: 'cron(0 9 * * ? *)',
      scheduleExpressionTimezone: 'Asia/Seoul',
      flexibleTimeWindow: { mode: 'OFF' },
      state: 'ENABLED',
      target: {
        arn: cluster.clusterArn,
        roleArn: schedulerRole.roleArn,
        ecsParameters: {
          taskDefinitionArn: workerTask.taskDefinitionArn,
          launchType: 'FARGATE',
          platformVersion: '1.4.0',
          taskCount: 1,
          enableExecuteCommand: false,
          networkConfiguration: {
            awsvpcConfiguration: {
              subnets: PRIVATE_SUBNET_IDS,
              securityGroups: [workerSecurityGroup.securityGroupId],
              assignPublicIp: 'DISABLED',
            },
          },
        },
        retryPolicy: { maximumEventAgeInSeconds: 3600, maximumRetryAttempts: 2 },
        deadLetterConfig: { arn: deadLetterQueue.queueArn },
      },
    });
    dailySchedule.node.addDependency(schedulerRole);
    dailySchedule.node.addDependency(workerTask);
    dailySchedule.node.addDependency(workerTaskRole);
    dailySchedule.node.addDependency(workerExecutionRole);

    new cloudwatch.Alarm(this, 'CollectionFailureAlarm', {
      alarmDescription: 'The collector reported a failed run; inspect the collector log group.',
      metric: new cloudwatch.Metric({
        namespace: 'CodePulse', metricName: 'CollectionFailure', dimensionsMap: { Application: 'code-pulse' },
        statistic: 'Sum', period: Duration.minutes(5),
      }),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    const missingSuccessAlarm = new cloudwatch.Alarm(this, 'MissingCollectionSuccessAlarm', {
      alarmDescription: 'Evaluates the last completed UTC calendar day after 00:00 UTC (09:00 Seoul); alarms when that day contains no successful collection.',
      metric: new cloudwatch.Metric({
        namespace: 'CodePulse', metricName: 'CollectionSuccess', dimensionsMap: { Application: 'code-pulse' },
        statistic: 'Sum', period: Duration.days(1),
      }),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.BREACHING,
    });
    (missingSuccessAlarm.node.defaultChild as cloudwatch.CfnAlarm).evaluationWindow = {
      wallClockWindow: { timezone: 'UTC' },
    };
    new cloudwatch.Alarm(this, 'Alb5xxAlarm', {
      alarmDescription: 'The load balancer is returning 5xx errors.',
      metric: loadBalancer.metrics.httpCodeElb(elbv2.HttpCodeElb.ELB_5XX_COUNT, { statistic: 'Sum', period: Duration.minutes(5) }),
      threshold: 5,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    new cloudwatch.Alarm(this, 'Target5xxAlarm', {
      alarmDescription: 'The web application is returning 5xx errors.',
      metric: targetGroup.metrics.httpCodeTarget(elbv2.HttpCodeTarget.TARGET_5XX_COUNT, { statistic: 'Sum', period: Duration.minutes(5) }),
      threshold: 5,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    new cloudwatch.Alarm(this, 'HealthyTargetsAlarm', {
      alarmDescription: 'No healthy web target is available behind the ALB.',
      metric: targetGroup.metrics.healthyHostCount({ statistic: 'Minimum', period: Duration.minutes(1) }),
      threshold: 1,
      evaluationPeriods: 3,
      comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.BREACHING,
    });
    new cloudwatch.Alarm(this, 'SchedulerDeadLetterAlarm', {
      alarmDescription: 'Scheduler could not start a collector task after retries; inspect the dead letter queue.',
      metric: deadLetterQueue.metricApproximateNumberOfMessagesVisible({ statistic: 'Maximum', period: Duration.minutes(5) }),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    const outputs: Record<string, string> = {
      SiteUrl: siteUrl,
      DistributionId: distribution.distributionId,
      DistributionDomainName: distribution.distributionDomainName,
      AlbDnsName: loadBalancer.loadBalancerDnsName,
      ClusterName: cluster.clusterName,
      ServiceName: webService.serviceName,
      WorkerTaskDefinitionArn: workerTask.taskDefinitionArn,
      WorkerSecurityGroupId: workerSecurityGroup.securityGroupId,
      PrivateSubnetIds: PRIVATE_SUBNET_IDS.join(','),
      DataBucketName: dataBucket.bucketName,
      PresenceTableName: presenceTable.tableName,
      ScheduleName: dailySchedule.ref,
      ScheduleGroupName: scheduleGroup.ref,
      SchedulerDeadLetterQueueUrl: deadLetterQueue.queueUrl,
      WebLogGroupName: webLogs.logGroupName,
      CollectorLogGroupName: collectorLogs.logGroupName,
    };
    for (const [name, value] of Object.entries(outputs)) new CfnOutput(this, name, { value });

    // Every exception belongs to a specific resource and is documented in the
    // infrastructure report. No stack-level suppressions are used.
    NagSuppressions.addResourceSuppressions(dataBucket, [
      { id: 'AwsSolutions-S1', reason: 'The bucket holds public-source snapshots and raw documents. Object access logging is omitted for the initial low-volume service; application runs and failures are recorded in CloudWatch.' },
    ]);
    NagSuppressions.addResourceSuppressions(originToken, [
      { id: 'AwsSolutions-SMG4', reason: 'Origin verification requires a coordinated CloudFront and ALB header rollout. Automatic secret rotation alone would not update both dynamic references; rotate through a controlled infrastructure update.' },
    ]);
    NagSuppressions.addResourceSuppressions(presenceSecret, [
      { id: 'AwsSolutions-SMG4', reason: 'The stable presence signing key preserves anonymous browser identities across deployments. Rotate through a coordinated cookie migration; rotating this key alone would invalidate existing browser identifiers.' },
    ]);
    NagSuppressions.addResourceSuppressions(loadBalancer, [
      { id: 'AwsSolutions-ELB2', reason: 'Dedicated S3 access logs are omitted for this initial public read service. Application request logs, ALB 5xx metrics and healthy target alarms are enabled.' },
    ]);
    NagSuppressions.addResourceSuppressions(distribution, [
      { id: 'AwsSolutions-CFR1', reason: 'The official changelog briefings are public content for readers in all countries. Geographic restrictions are not part of the service requirements.' },
      { id: 'AwsSolutions-CFR2', reason: 'Public content permits GET and HEAD. The uncached presence endpoint uses server-side GET/POST and origin checks with writes restricted to its dedicated table. Web tasks have no model or S3 write rights, and a managed prefix list and secret header protect the origin. WAF can be added if traffic warrants it.' },
      { id: 'AwsSolutions-CFR3', reason: 'CloudFront access logs are omitted for the initial low-volume service; the application records requests and errors and ALB alarms monitor origin health.' },
      { id: 'AwsSolutions-CFR5', reason: 'The approved architecture uses HTTP from CloudFront to the public ALB, matching the existing site. The ALB accepts only the CloudFront managed prefix list and a Secrets Manager header; its default action is 403.' },
    ]);
    for (const definition of [webTask, workerTask]) {
      NagSuppressions.addResourceSuppressions(definition, [
        { id: 'AwsSolutions-ECS2', reason: 'Plain environment variables contain only bucket and table names, region, public URLs, model identifier and runtime flags. The web presence signing key uses ECS Secrets Manager injection and is not stored in the plain environment configuration.' },
      ]);
    }
    const bucketLogicalId = this.getLogicalId(dataBucket.node.defaultChild as s3.CfnBucket);
    NagSuppressions.addResourceSuppressions(webTaskRole.node.findChild('DefaultPolicy'), [
      {
        id: 'AwsSolutions-IAM5',
        reason: 'The web role reads S3 objects only below published/. GetObject is its sole S3 action and object names change with the published dataset. No bucket listing, S3 write or model invocation is allowed; presence operations are scoped separately to their table.',
        appliesTo: [`Resource::<${bucketLogicalId}.Arn>/published/*`],
      },
    ], true);
    NagSuppressions.addResourceSuppressions(workerTaskRole.node.findChild('DefaultPolicy'), [
      {
        id: 'AwsSolutions-IAM5',
        reason: 'The collector writes content-addressed official source documents below raw/. The wildcard covers changing object keys inside this one prefix and permits only PutObject.',
        appliesTo: [`Resource::<${bucketLogicalId}.Arn>/raw/*`],
      },
      {
        id: 'AwsSolutions-IAM5',
        reason: 'Global inference evaluates regional and regionless foundation model ARNs. Only the exact Haiku 5.5 model ID is allowed, with a bedrock:InferenceProfileArn condition restricting invocation to the verified profile. See the official Bedrock inference-profiles-prereq documentation.',
        appliesTo: [`Resource::arn:<AWS::Partition>:bedrock:*::foundation-model/${FOUNDATION_MODEL_ID}`],
      },
    ], true);
    for (const executionRole of [webExecutionRole, workerExecutionRole]) {
      NagSuppressions.addResourceSuppressions(executionRole.node.findChild('DefaultPolicy'), [
        {
          id: 'AwsSolutions-IAM5',
          reason: 'ECR GetAuthorizationToken does not support resource-level permissions. Image downloads are limited to the CDK asset and Seoul GuardDuty agent repositories; log writes stay within this task log group.',
          appliesTo: ['Resource::*'],
        },
      ], true);
    }
    NagSuppressions.addResourceSuppressions(deadLetterQueue, [
      { id: 'AwsSolutions-SQS3', reason: 'This queue is itself the terminal Scheduler dead letter queue. A second redrive destination would not serve a consumer; retain failures for 14 days and alarm when messages are present.' },
    ]);
  }
}

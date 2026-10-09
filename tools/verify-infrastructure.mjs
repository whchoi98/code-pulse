import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { parseArgs, promisify } from 'node:util';

const { values: options } = parseArgs({ options: {
  output: { type: 'string', default: 'docs/infrastructure-verification.json' },
} });
assert.ok(options.output.trim(), '--output must name a report file.');
const execute = promisify(execFile);
const outputs = JSON.parse(await readFile('cdk-outputs.json', 'utf8')).CodePulse;
assert.ok(typeof outputs?.PresenceTableName === 'string' && outputs.PresenceTableName.length > 0,
  'PresenceTableName is missing from the deployed stack outputs.');
assert.ok(typeof outputs.SiteBucketName === 'string' && outputs.SiteBucketName.length > 0
  && outputs.SiteBucketName !== outputs.DataBucketName,
'The deployed site bucket must exist separately from the private data bucket.');
assert.equal(outputs.StaticRoutingEnabled, 'true',
  'Run final infrastructure verification after static routing is enabled.');
const SITE_HOSTNAME = 'code-pulse.whchoi.net';
const SITE_URL = `https://${SITE_HOSTNAME}`;
const CERTIFICATE_REGION = 'us-east-1';
const CERTIFICATE_ARN = 'arn:aws:acm:us-east-1:061525506239:certificate/7d53182a-2a2a-4225-a319-4f94030561b7';
assert.equal(outputs.SiteUrl, SITE_URL, 'The deployed site URL must use the canonical custom hostname.');
const PRESENCE_CACHE_POLICY = '4135ea2d-6df8-44a3-9df3-4b5a84be39ad';
const PRESENCE_ORIGIN_POLICY = '216adef6-5c7f-47e4-b989-5492eafa07d3';
const IMMUTABLE_CACHE_POLICY = '658327ea-f89d-4fab-a63d-7e88639e58f6';
const PRESENCE_ACTIONS = ['dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:Query', 'dynamodb:UpdateItem'];
const distributionArn = `arn:aws:cloudfront::061525506239:distribution/${outputs.DistributionId}`;
const dataBucketArn = `arn:aws:s3:::${outputs.DataBucketName}`;
const siteBucketArn = `arn:aws:s3:::${outputs.SiteBucketName}`;
const values = value => value === undefined ? [] : Array.isArray(value) ? value : [value];
const aws = async (parameters, region = 'ap-northeast-2') => {
  try {
    const { stdout } = await execute('aws', [...parameters, '--region', region, '--output', 'json'], { maxBuffer: 4 * 1024 * 1024, timeout: 30_000 });
    return JSON.parse(stdout);
  } catch {
    // Configuration APIs can return origin header values. Never echo captured
    // stdout or an assertion's actual values into the verification transcript.
    throw new Error(`AWS verification query failed: ${parameters[0]} ${parameters[1]}`);
  }
};
async function parallel(jobs) {
  const names = Object.keys(jobs);
  const results = await Promise.allSettled(names.map(name => jobs[name]()));
  const failures = results.flatMap((result, index) => result.status === 'rejected' ? [`${names[index]}: ${result.reason.message}`] : []);
  if (failures.length) throw new Error(failures.join('\n'));
  return Object.fromEntries(results.map((result, index) => [names[index], result.value]));
}
async function roleStatements(roleName, inlinePolicyNames, attachedPolicies) {
  const documents = await Promise.all([
    ...inlinePolicyNames.map(name => aws([
      'iam', 'get-role-policy', '--role-name', roleName, '--policy-name', name, '--query', 'PolicyDocument',
    ])),
    ...attachedPolicies.map(async policy => {
      const version = await aws(['iam', 'get-policy', '--policy-arn', policy.PolicyArn, '--query', 'Policy.DefaultVersionId']);
      return aws(['iam', 'get-policy-version', '--policy-arn', policy.PolicyArn, '--version-id', version, '--query', 'PolicyVersion.Document']);
    }),
  ]);
  return documents.flatMap(document => {
    assert.ok(document && typeof document === 'object' && document.Statement,
      'An IAM policy document could not be inspected.');
    return values(document.Statement);
  });
}
function dynamoAllowStatements(statements) {
  const allowed = statements.filter(statement => statement.Effect === 'Allow');
  // The deployed roles use explicit actions/resources. Fail rather than claim
  // isolation when an unexpected inverse policy cannot be checked here.
  assert.ok(allowed.every(statement => statement.Action !== undefined
    && statement.NotAction === undefined && statement.NotResource === undefined),
  'An unexpected inverse IAM grant prevents presence permission verification.');
  return allowed.filter(statement => values(statement.Action).some(action =>
    action === '*' || (typeof action === 'string' && action.toLowerCase().startsWith('dynamodb:'))));
}
function s3AllowStatements(statements) {
  return statements.filter(statement => statement.Effect === 'Allow' && values(statement.Action).some(action =>
    action === '*' || (typeof action === 'string' && action.toLowerCase().startsWith('s3:'))));
}
function verifyS3Grants(statements, expected, label) {
  const actual = new Set();
  for (const statement of s3AllowStatements(statements)) {
    assert.ok(statement.Condition === undefined && values(statement.Resource).length > 0,
      `${label} S3 grants must use the explicit unconditional resource scopes.`);
    for (const resource of values(statement.Resource)) {
      for (const action of values(statement.Action)) {
        const pair = `${String(action).toLowerCase()} ${resource}`;
        assert.ok(expected.has(pair), `${label} has an unexpected S3 action or resource scope.`);
        actual.add(pair);
      }
    }
  }
  assert.ok(actual.size === expected.size && [...expected].every(pair => actual.has(pair)),
    `${label} is missing a required S3 grant.`);
}
const first = await parallel({
  stack: () => aws(['cloudformation', 'describe-stacks', '--stack-name', 'CodePulse', '--query', 'Stacks[0].StackStatus']),
  resources: () => aws(['cloudformation', 'describe-stack-resources', '--stack-name', 'CodePulse', '--query', 'StackResources']),
  distribution: () => aws(['cloudfront', 'get-distribution', '--id', outputs.DistributionId, '--query',
    `Distribution.{
      Status:Status,Domain:DomainName,Enabled:DistributionConfig.Enabled,
      Aliases:DistributionConfig.Aliases.Items,
      ViewerCertificate:DistributionConfig.ViewerCertificate.{
        ACMCertificateArn:ACMCertificateArn,CloudFrontDefaultCertificate:CloudFrontDefaultCertificate,
        MinimumProtocolVersion:MinimumProtocolVersion,SSLSupportMethod:SSLSupportMethod
      },
      Protocol:DistributionConfig.DefaultCacheBehavior.ViewerProtocolPolicy,
      DefaultPolicy:DistributionConfig.DefaultCacheBehavior.CachePolicyId,
      DefaultOrigin:DistributionConfig.DefaultCacheBehavior.TargetOriginId,
      DefaultRootObject:DistributionConfig.DefaultRootObject,
      DefaultFunctionAssociations:DistributionConfig.DefaultCacheBehavior.FunctionAssociations.Items,
      ApiPolicy:DistributionConfig.CacheBehaviors.Items[?PathPattern=='/api/*'].CachePolicyId|[0],
      OriginDomains:DistributionConfig.Origins.Items[].DomainName,
      OriginHeaders:DistributionConfig.Origins.Items[].CustomHeaders.Items[].HeaderName,
      Origins:DistributionConfig.Origins.Items[].{
        Id:Id,Domain:DomainName,Path:OriginPath,OacId:OriginAccessControlId,
        S3OriginIdentity:S3OriginConfig.OriginAccessIdentity,
        CustomOriginProtocol:CustomOriginConfig.OriginProtocolPolicy,
        HeaderNames:CustomHeaders.Items[].HeaderName
      },
      Behaviors:DistributionConfig.CacheBehaviors.Items[].{
        Path:PathPattern,CachePolicy:CachePolicyId,OriginPolicy:OriginRequestPolicyId,
        Methods:AllowedMethods.Items,Protocol:ViewerProtocolPolicy,Origin:TargetOriginId,
        FunctionAssociations:FunctionAssociations.Items
      }
    }`]),
  service: () => aws(['ecs', 'describe-services', '--cluster', outputs.ClusterName, '--services', outputs.ServiceName, '--query', 'services[0]']),
  schedule: () => aws(['scheduler', 'get-schedule', '--name', outputs.ScheduleName, '--group-name', outputs.ScheduleGroupName]),
  publicBlock: () => aws(['s3api', 'get-public-access-block', '--bucket', outputs.DataBucketName, '--query', 'PublicAccessBlockConfiguration']),
  encryption: () => aws(['s3api', 'get-bucket-encryption', '--bucket', outputs.DataBucketName, '--query', 'ServerSideEncryptionConfiguration.Rules']),
  versioning: () => aws(['s3api', 'get-bucket-versioning', '--bucket', outputs.DataBucketName]),
  sitePublicBlock: () => aws(['s3api', 'get-public-access-block', '--bucket', outputs.SiteBucketName, '--query', 'PublicAccessBlockConfiguration']),
  siteEncryption: () => aws(['s3api', 'get-bucket-encryption', '--bucket', outputs.SiteBucketName, '--query', 'ServerSideEncryptionConfiguration.Rules']),
  siteVersioning: () => aws(['s3api', 'get-bucket-versioning', '--bucket', outputs.SiteBucketName]),
  siteOwnership: () => aws(['s3api', 'get-bucket-ownership-controls', '--bucket', outputs.SiteBucketName, '--query', 'OwnershipControls.Rules']),
  sitePolicy: () => aws(['s3api', 'get-bucket-policy', '--bucket', outputs.SiteBucketName, '--query', 'Policy']),
  sitePolicyStatus: () => aws(['s3api', 'get-bucket-policy-status', '--bucket', outputs.SiteBucketName, '--query', 'PolicyStatus.IsPublic']),
  presenceTable: () => aws(['dynamodb', 'describe-table', '--table-name', outputs.PresenceTableName, '--query', 'Table']),
  presenceTtl: () => aws(['dynamodb', 'describe-time-to-live', '--table-name', outputs.PresenceTableName, '--query', 'TimeToLiveDescription']),
  presenceBackups: () => aws(['dynamodb', 'describe-continuous-backups', '--table-name', outputs.PresenceTableName, '--query', 'ContinuousBackupsDescription']),
});
assert.ok(['CREATE_COMPLETE', 'UPDATE_COMPLETE'].includes(first.stack));
assert.equal(first.distribution.Status, 'Deployed');
assert.equal(first.distribution.Enabled, true);
assert.equal(first.distribution.Domain, outputs.DistributionDomainName);
assert.deepEqual(first.distribution.Aliases, [SITE_HOSTNAME],
  'The CloudFront aliases must contain only the canonical custom hostname.');
assert.equal(first.distribution.ViewerCertificate?.ACMCertificateArn, CERTIFICATE_ARN,
  'CloudFront must use the existing US East wildcard certificate.');
assert.ok(first.distribution.ViewerCertificate.CloudFrontDefaultCertificate !== true,
  'The custom hostname must not use the default CloudFront certificate.');
assert.equal(first.distribution.ViewerCertificate.MinimumProtocolVersion, 'TLSv1.2_2021');
assert.equal(first.distribution.ViewerCertificate.SSLSupportMethod, 'sni-only');
const functions = first.resources.filter(resource => resource.ResourceType === 'AWS::CloudFront::Function');
assert.equal(functions.length, 2, 'The stack must own separate canonical-host and static-router functions.');
function functionArn(logicalPrefix) {
  const matches = functions.filter(resource => resource.LogicalResourceId.startsWith(logicalPrefix));
  assert.equal(matches.length, 1, `The ${logicalPrefix} CloudFront function must exist exactly once.`);
  const identifier = matches[0].PhysicalResourceId;
  assert.ok(typeof identifier === 'string' && identifier.length > 0,
    `The ${logicalPrefix} function physical identifier is missing.`);
  const arn = identifier.startsWith('arn:') ? identifier : `arn:aws:cloudfront::061525506239:function/${identifier}`;
  assert.ok(arn.startsWith('arn:aws:cloudfront::061525506239:function/'),
    `The ${logicalPrefix} function must belong to the expected AWS account.`);
  return arn;
}
const canonicalFunctionArn = functionArn('CanonicalHost');
const staticRouterArn = functionArn('StaticRouter');
assert.notEqual(canonicalFunctionArn, staticRouterArn);
const dynamicPaths = ['/api/presence', '/api/*', '/feed.xml', '/healthz'];
const staticPaths = ['/content/objects/*', '/content/*', '/assets/*', '/fonts/*', '/brand/*'];
assert.deepEqual(first.distribution.Behaviors.map(behavior => behavior.Path).sort(), [...dynamicPaths, ...staticPaths].sort(),
  'The distribution must have exactly the expected API, RSS, health and static behaviors.');
const allBehaviors = [
  { Path: '*', FunctionAssociations: first.distribution.DefaultFunctionAssociations },
  ...first.distribution.Behaviors,
];
const canonicalBehaviors = allBehaviors.filter(behavior => dynamicPaths.includes(behavior.Path));
const staticBehaviors = allBehaviors.filter(behavior => !dynamicPaths.includes(behavior.Path));
for (const behavior of allBehaviors) {
  const expectedFunction = dynamicPaths.includes(behavior.Path) ? canonicalFunctionArn : staticRouterArn;
  assert.deepEqual(behavior.FunctionAssociations, [{ EventType: 'viewer-request', FunctionARN: expectedFunction }],
    `The ${behavior.Path} behavior must use its correct viewer-request function.`);
}
assert.equal(first.distribution.Protocol, 'redirect-to-https');
assert.equal(first.distribution.DefaultPolicy, first.distribution.ApiPolicy);
assert.equal(first.distribution.DefaultRootObject, 'pages/ko/index.html');
const siteDomain = `${outputs.SiteBucketName}.s3.ap-northeast-2.amazonaws.com`;
assert.deepEqual([...first.distribution.OriginDomains].sort(), [outputs.AlbDnsName, siteDomain].sort());
assert.equal(first.distribution.Origins.length, 2, 'Only the protected ALB and private site bucket may be origins.');
const albOrigin = first.distribution.Origins.find(origin => origin.Domain === outputs.AlbDnsName);
const staticOrigin = first.distribution.Origins.find(origin => origin.Domain === siteDomain);
assert.ok(albOrigin && staticOrigin && albOrigin.Id !== staticOrigin.Id, 'The ALB and S3 origin IDs must be distinct.');
assert.equal(first.distribution.DefaultOrigin, staticOrigin.Id);
assert.equal(albOrigin.CustomOriginProtocol, 'http-only');
assert.ok(!albOrigin.OacId && !albOrigin.Path);
assert.deepEqual(albOrigin.HeaderNames, ['X-Code-Pulse-Origin']);
assert.equal(staticOrigin.S3OriginIdentity, '', 'The static origin must use OAC, not a legacy OAI.');
assert.ok(typeof staticOrigin.OacId === 'string' && staticOrigin.OacId.length > 0
  && !staticOrigin.CustomOriginProtocol && !staticOrigin.Path,
'The private S3 origin must use its OAC without a custom-origin path.');
assert.deepEqual(staticOrigin.HeaderNames ?? [], []);
assert.deepEqual(first.distribution.OriginHeaders, ['X-Code-Pulse-Origin']);
const oacResources = first.resources.filter(resource => resource.ResourceType === 'AWS::CloudFront::OriginAccessControl');
assert.equal(oacResources.length, 1, 'The stack must own exactly one S3 origin access control.');
assert.equal(staticOrigin.OacId, oacResources[0].PhysicalResourceId);
const cacheResources = first.resources.filter(resource => resource.ResourceType === 'AWS::CloudFront::CachePolicy');
assert.equal(cacheResources.length, 1, 'The deployment must retain a single custom cache policy.');
assert.equal(first.distribution.DefaultPolicy, cacheResources[0].PhysicalResourceId);
for (const behavior of first.distribution.Behaviors) {
  const expectedOrigin = dynamicPaths.includes(behavior.Path) ? albOrigin.Id : staticOrigin.Id;
  assert.equal(behavior.Origin, expectedOrigin, `The ${behavior.Path} behavior has the wrong origin.`);
  assert.equal(behavior.Protocol, 'redirect-to-https');
  const expectedPolicy = ['/api/presence', '/healthz'].includes(behavior.Path) ? PRESENCE_CACHE_POLICY
    : ['/content/objects/*', '/assets/*', '/fonts/*', '/brand/*'].includes(behavior.Path)
      ? IMMUTABLE_CACHE_POLICY : first.distribution.DefaultPolicy;
  assert.equal(behavior.CachePolicy, expectedPolicy, `The ${behavior.Path} behavior has the wrong cache policy.`);
  if (behavior.Path !== '/api/presence') assert.deepEqual([...behavior.Methods].sort(), ['GET', 'HEAD']);
}
assert.ok(first.distribution.Behaviors.findIndex(behavior => behavior.Path === '/content/objects/*')
  < first.distribution.Behaviors.findIndex(behavior => behavior.Path === '/content/*'),
'Immutable detail objects must match their behavior before the mutable catalog prefix.');
const presenceIndex = first.distribution.Behaviors.findIndex(behavior => behavior.Path === '/api/presence');
const apiIndex = first.distribution.Behaviors.findIndex(behavior => behavior.Path === '/api/*');
assert.ok(presenceIndex >= 0 && presenceIndex < apiIndex,
  'The exact presence behavior must precede the read-only API behavior.');
const presenceBehavior = first.distribution.Behaviors[presenceIndex];
assert.equal(presenceBehavior.CachePolicy, PRESENCE_CACHE_POLICY);
assert.equal(presenceBehavior.OriginPolicy, PRESENCE_ORIGIN_POLICY);
assert.equal(presenceBehavior.Protocol, 'redirect-to-https');
assert.deepEqual([...presenceBehavior.Methods].sort(), ['DELETE', 'GET', 'HEAD', 'OPTIONS', 'PATCH', 'POST', 'PUT']);
assert.deepEqual([...first.distribution.Behaviors[apiIndex].Methods].sort(), ['GET', 'HEAD']);
assert.equal(presenceBehavior.Origin, first.distribution.Behaviors[apiIndex].Origin);
assert.equal(first.resources.some(resource => ['AWS::EC2::VPC', 'AWS::EC2::NatGateway', 'AWS::EC2::Subnet', 'AWS::EC2::Route', 'AWS::EC2::VPCEndpoint'].includes(resource.ResourceType)), false);
assert.equal(first.resources.filter(resource => resource.ResourceType === 'AWS::CloudFront::CachePolicy').length, 1);
assert.equal(first.service.networkConfiguration.awsvpcConfiguration.assignPublicIp, 'DISABLED');
assert.ok(first.service.runningCount >= 1);
assert.equal(first.service.pendingCount, 0);
assert.equal(first.schedule.State, 'ENABLED');
assert.equal(first.schedule.ScheduleExpression, 'cron(0 7 * * ? *)');
assert.equal(first.schedule.ScheduleExpressionTimezone, 'Asia/Seoul');
assert.equal(first.schedule.FlexibleTimeWindow.Mode, 'OFF');
assert.equal(first.schedule.Target.EcsParameters.TaskDefinitionArn, outputs.WorkerTaskDefinitionArn);
assert.equal(first.schedule.Target.EcsParameters.TaskCount, 1);
const workerNetwork = first.schedule.Target.EcsParameters.NetworkConfiguration.awsvpcConfiguration;
assert.equal(workerNetwork.AssignPublicIp, 'DISABLED');
assert.deepEqual([...workerNetwork.Subnets].sort(), outputs.PrivateSubnetIds.split(',').sort());
assert.deepEqual(workerNetwork.SecurityGroups, [outputs.WorkerSecurityGroupId]);
assert.deepEqual(first.publicBlock, { BlockPublicAcls: true, IgnorePublicAcls: true, BlockPublicPolicy: true, RestrictPublicBuckets: true });
assert.equal(first.encryption[0].ApplyServerSideEncryptionByDefault.SSEAlgorithm, 'AES256');
assert.equal(first.versioning.Status, 'Enabled');
assert.deepEqual(first.sitePublicBlock, { BlockPublicAcls: true, IgnorePublicAcls: true, BlockPublicPolicy: true, RestrictPublicBuckets: true });
assert.equal(first.siteEncryption[0].ApplyServerSideEncryptionByDefault.SSEAlgorithm, 'AES256');
assert.equal(first.siteVersioning.Status, 'Enabled');
assert.deepEqual(first.siteOwnership, [{ ObjectOwnership: 'BucketOwnerEnforced' }]);
assert.equal(first.sitePolicyStatus, false, 'The site bucket policy must not be public.');
const sitePolicy = typeof first.sitePolicy === 'string' ? JSON.parse(first.sitePolicy) : first.sitePolicy;
assert.ok(sitePolicy && typeof sitePolicy === 'object' && sitePolicy.Statement, 'The site bucket policy must be inspectable.');
const siteStatements = values(sitePolicy.Statement);
const cloudFrontStatements = siteStatements.filter(statement => values(statement.Principal?.Service).includes('cloudfront.amazonaws.com'));
const scopedCloudFrontRead = cloudFrontStatements.some(statement => statement.Effect === 'Allow'
  && values(statement.Action).includes('s3:GetObject') && values(statement.Resource).includes(`${siteBucketArn}/*`)
  && statement.Condition?.StringEquals?.['AWS:SourceArn'] === distributionArn);
assert.ok(scopedCloudFrontRead, 'Only this distribution must be granted OAC object reads.');
assert.ok(cloudFrontStatements.filter(statement => statement.Effect === 'Allow').every(statement =>
  statement.Condition?.StringEquals?.['AWS:SourceArn'] === distributionArn
  && values(statement.Action).every(action => ['s3:GetObject', 's3:ListBucket'].includes(action))
  && values(statement.Resource).every(resource => [siteBucketArn, `${siteBucketArn}/*`].includes(resource))),
'CloudFront site access must stay read-only and scoped to this distribution.');
assert.ok(cloudFrontStatements.some(statement => statement.Effect === 'Deny' && statement.Condition === undefined
  && values(statement.Action).includes('s3:GetObject') && values(statement.Resource).includes(`${siteBucketArn}/_publication/*`)),
'CloudFront must be explicitly denied every private publication control object.');
assert.ok(siteStatements.every(statement => statement.Effect !== 'Allow'
  || (statement.Principal !== '*' && !values(statement.Principal?.AWS).includes('*'))),
'The site bucket must not contain a public principal Allow grant.');
assert.ok(siteStatements.filter(statement => statement.Effect === 'Allow').every(statement =>
  statement.Principal && Object.keys(statement.Principal).length === 1
  && JSON.stringify(values(statement.Principal.Service)) === JSON.stringify(['cloudfront.amazonaws.com'])
  && statement.NotPrincipal === undefined),
'The site bucket resource policy may grant access only to CloudFront; task access belongs in the scoped identity policies.');
assert.equal(first.presenceTable.TableName, outputs.PresenceTableName);
assert.equal(first.presenceTable.TableArn, `arn:aws:dynamodb:ap-northeast-2:061525506239:table/${outputs.PresenceTableName}`);
assert.equal(first.presenceTable.TableStatus, 'ACTIVE');
assert.equal(first.presenceTable.BillingModeSummary?.BillingMode, 'PAY_PER_REQUEST');
assert.deepEqual([...first.presenceTable.KeySchema].sort((a, b) => a.AttributeName.localeCompare(b.AttributeName)),
  [{ AttributeName: 'pk', KeyType: 'HASH' }, { AttributeName: 'sk', KeyType: 'RANGE' }]);
assert.deepEqual([...first.presenceTable.AttributeDefinitions].sort((a, b) => a.AttributeName.localeCompare(b.AttributeName)),
  [{ AttributeName: 'pk', AttributeType: 'S' }, { AttributeName: 'sk', AttributeType: 'S' }]);
assert.equal(first.presenceTtl.AttributeName, 'expires_at');
assert.equal(first.presenceTtl.TimeToLiveStatus, 'ENABLED');
assert.equal(first.presenceBackups.ContinuousBackupsStatus, 'ENABLED');
assert.equal(first.presenceBackups.PointInTimeRecoveryDescription?.PointInTimeRecoveryStatus, 'ENABLED');
assert.equal(first.presenceTable.SSEDescription?.Status, 'ENABLED');
assert.equal(first.presenceTable.SSEDescription?.SSEType, 'KMS');
const resource = type => first.resources.find(item => item.ResourceType === type).PhysicalResourceId;
const loadBalancerArn = resource('AWS::ElasticLoadBalancingV2::LoadBalancer');
const targetGroupArn = resource('AWS::ElasticLoadBalancingV2::TargetGroup');
const second = await parallel({
  oac: () => aws(['cloudfront', 'get-origin-access-control', '--id', staticOrigin.OacId,
    '--query', 'OriginAccessControl.OriginAccessControlConfig']),
  certificate: () => aws(['acm', 'describe-certificate',
    '--certificate-arn', first.distribution.ViewerCertificate.ACMCertificateArn,
    '--query', 'Certificate.{CertificateArn:CertificateArn,Status:Status,DomainName:DomainName,SubjectAlternativeNames:SubjectAlternativeNames}'],
  CERTIFICATE_REGION),
  loadBalancer: () => aws(['elbv2', 'describe-load-balancers', '--load-balancer-arns', loadBalancerArn, '--query', 'LoadBalancers[0]']),
  targets: () => aws(['elbv2', 'describe-target-health', '--target-group-arn', targetGroupArn, '--query', 'TargetHealthDescriptions']),
  listeners: () => aws(['elbv2', 'describe-listeners', '--load-balancer-arn', loadBalancerArn, '--query', 'Listeners']),
  cache: () => aws(['cloudfront', 'get-cache-policy', '--id', first.distribution.DefaultPolicy, '--query', 'CachePolicy.CachePolicyConfig']),
  presenceCache: () => aws(['cloudfront', 'get-cache-policy', '--id', presenceBehavior.CachePolicy, '--query', 'CachePolicy.CachePolicyConfig']),
  presenceOriginPolicy: () => aws(['cloudfront', 'get-origin-request-policy', '--id', presenceBehavior.OriginPolicy, '--query', 'OriginRequestPolicy.OriginRequestPolicyConfig']),
  webDefinition: () => aws(['ecs', 'describe-task-definition', '--task-definition', first.service.taskDefinition, '--query', 'taskDefinition']),
  workerDefinition: () => aws(['ecs', 'describe-task-definition', '--task-definition', outputs.WorkerTaskDefinitionArn, '--query', 'taskDefinition']),
  taskList: () => aws(['ecs', 'list-tasks', '--cluster', outputs.ClusterName, '--service-name', outputs.ServiceName]),
});
assert.equal(second.oac.OriginAccessControlOriginType, 's3');
assert.equal(second.oac.SigningProtocol, 'sigv4');
assert.equal(second.oac.SigningBehavior, 'always');
assert.equal(second.certificate.CertificateArn, CERTIFICATE_ARN);
assert.equal(second.certificate.CertificateArn.split(':')[3], CERTIFICATE_REGION);
assert.equal(second.certificate.Status, 'ISSUED', 'The CloudFront ACM certificate must remain issued.');
assert.ok(Array.isArray(second.certificate.SubjectAlternativeNames)
  && second.certificate.SubjectAlternativeNames.includes('*.whchoi.net'),
'The CloudFront certificate must cover the custom hostname through its wildcard SAN.');
assert.equal(second.loadBalancer.VpcId, 'vpc-0dfa5610180dfa628');
assert.ok(second.targets.some(target => target.TargetHealth.State === 'healthy'));
assert.equal(second.cache.MinTTL, 0);
assert.equal(second.cache.DefaultTTL, 0);
assert.equal(second.cache.MaxTTL, 60);
assert.equal(second.presenceCache.MinTTL, 0);
assert.equal(second.presenceCache.DefaultTTL, 0);
assert.equal(second.presenceCache.MaxTTL, 0);
assert.equal(second.presenceOriginPolicy.HeadersConfig.HeaderBehavior, 'allViewer');
assert.equal(second.presenceOriginPolicy.CookiesConfig.CookieBehavior, 'all');
assert.equal(second.presenceOriginPolicy.QueryStringsConfig.QueryStringBehavior, 'all');
assert.equal(second.listeners[0].Port, 80);
assert.equal(second.listeners[0].DefaultActions[0].FixedResponseConfig.StatusCode, '403');
assert.equal(second.webDefinition.runtimePlatform.cpuArchitecture, 'ARM64');
assert.equal(second.workerDefinition.runtimePlatform.cpuArchitecture, 'ARM64');
assert.equal(second.webDefinition.cpu, '256');
assert.equal(second.webDefinition.memory, '512');
assert.equal(second.workerDefinition.cpu, '512');
assert.equal(second.workerDefinition.memory, '1024');
const webContainer = second.webDefinition.containerDefinitions.find(container => container.name === 'web');
const workerContainer = second.workerDefinition.containerDefinitions.find(container => container.name === 'collector');
assert.ok(webContainer && workerContainer, 'The expected web and collector containers must exist.');
const webEnvironment = new Map((webContainer.environment ?? []).map(variable => [variable.name, variable.value]));
const workerEnvironment = new Map((workerContainer.environment ?? []).map(variable => [variable.name, variable.value]));
assert.ok(workerEnvironment.get('SITE_BUCKET') === outputs.SiteBucketName,
  'The collector SITE_BUCKET must identify the separate published site bucket.');
assert.ok(workerEnvironment.get('STATIC_DIR') === '/app/dist/public' && !workerEnvironment.has('SITE_DIR'),
  'The collector must publish its compiled frontend to S3.');
assert.ok(!webEnvironment.has('SITE_BUCKET') && !webEnvironment.has('SITE_DIR'),
  'The web container must not receive static publication destinations.');
assert.ok(webEnvironment.get('DATA_BUCKET') === outputs.DataBucketName && workerEnvironment.get('DATA_BUCKET') === outputs.DataBucketName,
  'Both tasks must retain the private snapshot bucket configuration.');
const siteOrigin = new URL(outputs.SiteUrl).origin;
assert.ok(webEnvironment.get('PUBLIC_BASE_URL') === SITE_URL,
  'Web PUBLIC_BASE_URL must match the canonical site URL.');
assert.ok(workerEnvironment.get('PUBLIC_BASE_URL') === SITE_URL,
  'Collector PUBLIC_BASE_URL must match the canonical site URL.');
assert.ok(webEnvironment.get('PRESENCE_TABLE') === outputs.PresenceTableName, 'Web PRESENCE_TABLE does not match the deployed table.');
assert.ok(webEnvironment.get('PUBLIC_ORIGIN') === siteOrigin, 'Web PUBLIC_ORIGIN does not match the site origin.');
assert.ok(!webEnvironment.has('PRESENCE_SECRET'), 'PRESENCE_SECRET must use ECS secret injection, not a plain environment value.');
const presenceSecretReference = webContainer.secrets?.find(secret => secret.name === 'PRESENCE_SECRET')?.valueFrom;
const presenceSecretResource = first.resources.find(item => item.ResourceType === 'AWS::SecretsManager::Secret'
  && item.LogicalResourceId.startsWith('PresenceSecret'));
assert.ok(typeof presenceSecretReference === 'string' && presenceSecretResource
  && presenceSecretReference === presenceSecretResource.PhysicalResourceId,
'The web presence signing secret must reference the dedicated stack secret.');
assert.ok(!(workerContainer.environment ?? []).some(variable => ['PRESENCE_TABLE', 'PRESENCE_SECRET', 'PUBLIC_ORIGIN'].includes(variable.name))
  && !(workerContainer.secrets ?? []).some(secret => secret.name === 'PRESENCE_SECRET'),
'Presence table and signing configuration must not be passed to the collector.');
const modelId = workerContainer.environment.find(variable => variable.name === 'BEDROCK_MODEL_ID')?.value;
assert.equal(modelId, 'global.anthropic.claude-haiku-5-5');
assert.equal(second.webDefinition.containerDefinitions[0].image, second.workerDefinition.containerDefinitions[0].image);
assert.ok(second.webDefinition.containerDefinitions.every(container => container.readonlyRootFilesystem));
assert.ok(second.workerDefinition.containerDefinitions.every(container => container.readonlyRootFilesystem));
const albGroup = second.loadBalancer.SecurityGroups[0];
const webGroup = first.service.networkConfiguration.awsvpcConfiguration.securityGroups[0];
const webRoleName = second.webDefinition.taskRoleArn.split('/').at(-1);
const workerRoleName = second.workerDefinition.taskRoleArn.split('/').at(-1);
const third = await parallel({
  groups: () => aws(['ec2', 'describe-security-groups', '--group-ids', albGroup, webGroup, outputs.WorkerSecurityGroupId, '--query', 'SecurityGroups']),
  headers: () => aws(['elbv2', 'describe-rules', '--listener-arn', second.listeners[0].ListenerArn, '--query', 'Rules[].Conditions[].HttpHeaderConfig.HttpHeaderName']),
  tasks: () => aws(['ecs', 'describe-tasks', '--cluster', outputs.ClusterName, '--tasks', ...second.taskList.taskArns, '--query', 'tasks']),
  workerPolicies: () => aws(['iam', 'list-role-policies', '--role-name', workerRoleName]),
  webPolicies: () => aws(['iam', 'list-role-policies', '--role-name', webRoleName]),
  webManagedPolicies: () => aws(['iam', 'list-attached-role-policies', '--role-name', webRoleName, '--query', 'AttachedPolicies']),
  workerManagedPolicies: () => aws(['iam', 'list-attached-role-policies', '--role-name', workerRoleName, '--query', 'AttachedPolicies']),
});
const policies = await parallel({
  web: () => roleStatements(webRoleName, third.webPolicies.PolicyNames, third.webManagedPolicies),
  worker: () => roleStatements(workerRoleName, third.workerPolicies.PolicyNames, third.workerManagedPolicies),
});
const webDynamoStatements = dynamoAllowStatements(policies.web);
const workerDynamoStatements = dynamoAllowStatements(policies.worker);
const webDynamoActions = [...new Set(webDynamoStatements.flatMap(statement => values(statement.Action))
  .map(action => action.toLowerCase()))].sort();
assert.ok(JSON.stringify(webDynamoActions) === JSON.stringify(PRESENCE_ACTIONS.map(action => action.toLowerCase()).sort()),
  'The web role must allow exactly the four presence item/query actions.');
assert.ok(webDynamoStatements.length > 0 && webDynamoStatements.every(statement =>
  values(statement.Resource).length === 1 && values(statement.Resource)[0] === first.presenceTable.TableArn),
'The web DynamoDB permissions must be scoped to the exact presence table ARN.');
assert.equal(workerDynamoStatements.length, 0, 'The collector role must have no DynamoDB Allow permissions.');
verifyS3Grants(policies.web, new Set([`s3:getobject ${dataBucketArn}/published/*`]), 'Web task role');
verifyS3Grants(policies.worker, new Set([
  `s3:getobject ${dataBucketArn}/published/snapshot.json`, `s3:putobject ${dataBucketArn}/published/snapshot.json`,
  `s3:putobject ${dataBucketArn}/raw/*`, `s3:listbucket ${dataBucketArn}`,
  `s3:getobject ${siteBucketArn}/*`, `s3:putobject ${siteBucketArn}/*`, `s3:listbucket ${siteBucketArn}`,
]), 'Collector task role');
// TransactWriteItems authorizes its Put/Update entries through PutItem and
// UpdateItem; it is not an additional IAM action.
const modelStatements = policies.worker
  .filter(statement => [statement.Action].flat().some(action => action.startsWith('bedrock:')));
const profileArn = `arn:aws:bedrock:ap-northeast-2:061525506239:inference-profile/${modelId}`;
assert.equal(modelStatements.length, 2);
assert.ok(modelStatements.every(statement => statement.Effect === 'Allow'
  && [statement.Action].flat().length === 1 && [statement.Action].flat()[0] === 'bedrock:InvokeModel'));
assert.ok(modelStatements.some(statement => JSON.stringify([statement.Resource].flat()) === JSON.stringify([profileArn])));
assert.ok(modelStatements.some(statement =>
  JSON.stringify([statement.Resource].flat()) === JSON.stringify(['arn:aws:bedrock:*::foundation-model/anthropic.claude-haiku-5-5'])
  && statement.Condition?.StringEquals?.['bedrock:InferenceProfileArn'] === profileArn));
const albPermissions = third.groups.find(group => group.GroupId === albGroup).IpPermissions;
assert.equal(albPermissions.length, 1);
assert.equal(albPermissions[0].FromPort, 80);
assert.equal(albPermissions[0].ToPort, 80);
assert.deepEqual(albPermissions[0].PrefixListIds.map(prefix => prefix.PrefixListId), ['pl-22a6434b']);
assert.equal(albPermissions[0].IpRanges.length + albPermissions[0].Ipv6Ranges.length + albPermissions[0].UserIdGroupPairs.length, 0);
const webPermissions = third.groups.find(group => group.GroupId === webGroup).IpPermissions;
assert.equal(webPermissions.length, 1);
assert.equal(webPermissions[0].FromPort, 8080);
assert.equal(webPermissions[0].ToPort, 8080);
assert.deepEqual(webPermissions[0].UserIdGroupPairs.map(peer => peer.GroupId), [albGroup]);
assert.equal(webPermissions[0].IpRanges.length + webPermissions[0].Ipv6Ranges.length + webPermissions[0].PrefixListIds.length, 0);
assert.equal(third.groups.find(group => group.GroupId === outputs.WorkerSecurityGroupId).IpPermissions.length, 0);
const albEgress = third.groups.find(group => group.GroupId === albGroup).IpPermissionsEgress;
assert.equal(albEgress.length, 1);
assert.equal(albEgress[0].FromPort, 8080);
assert.equal(albEgress[0].ToPort, 8080);
assert.deepEqual(albEgress[0].UserIdGroupPairs.map(peer => peer.GroupId), [webGroup]);
assert.equal(albEgress[0].IpRanges.length + albEgress[0].Ipv6Ranges.length + albEgress[0].PrefixListIds.length, 0);
for (const id of [webGroup, outputs.WorkerSecurityGroupId]) {
  const egress = third.groups.find(group => group.GroupId === id).IpPermissionsEgress;
  assert.equal(egress.length, 1);
  assert.equal(egress[0].IpProtocol, 'tcp');
  assert.equal(egress[0].FromPort, 443);
  assert.equal(egress[0].ToPort, 443);
  assert.deepEqual(egress[0].IpRanges.map(range => range.CidrIp), ['0.0.0.0/0']);
}
assert.ok(third.headers.includes('X-Code-Pulse-Origin'));
const originConfiguration = await aws(['cloudfront', 'get-distribution-config', '--id', outputs.DistributionId]);
const listenerRules = await aws(['elbv2', 'describe-rules', '--listener-arn', second.listeners[0].ListenerArn]);
// Origin order changes when S3 becomes the default. Select the inspected ALB ID
// and reduce its sensitive configuration to a boolean match only.
const protectedOrigin = originConfiguration.DistributionConfig.Origins.Items.find(origin => origin.Id === albOrigin.Id);
const token = protectedOrigin?.CustomHeaders?.Items
  ?.find(header => header.HeaderName.toLowerCase() === 'x-code-pulse-origin')?.HeaderValue;
const protectedRules = listenerRules.Rules.filter(rule => !rule.IsDefault);
const tokenValues = protectedRules[0]?.Conditions.find(condition => condition.Field === 'http-header')?.HttpHeaderConfig.Values;
const originTokenMatched = protectedRules.length === 1 && typeof token === 'string' && /^[A-Za-z0-9]{48}$/.test(token)
  && tokenValues?.length === 1 && tokenValues[0] === token;
assert.ok(originTokenMatched, 'Origin token configuration did not match the expected protected origin.');
const liveTasks = third.tasks.filter(task => task.lastStatus === 'RUNNING' && task.desiredStatus === 'RUNNING');
assert.ok(liveTasks.length >= 1);
assert.ok(liveTasks.every(task => task.taskDefinitionArn === first.service.taskDefinition),
  'Every running web task must use the inspected task definition.');
assert.ok(liveTasks.every(task => task.containers.some(container => container.name.startsWith('aws-guardduty-agent-') && container.lastStatus === 'RUNNING')));
const interfaces = liveTasks.flatMap(task => task.attachments.flatMap(attachment => attachment.details.filter(detail => detail.name === 'networkInterfaceId').map(detail => detail.value)));
const networks = await aws(['ec2', 'describe-network-interfaces', '--network-interface-ids', ...interfaces, '--query', 'NetworkInterfaces[].{Vpc:VpcId,Subnet:SubnetId,PrivateIp:PrivateIpAddress,PublicIp:Association.PublicIp}']);
assert.ok(networks.every(network => network.Vpc === 'vpc-0dfa5610180dfa628' && outputs.PrivateSubnetIds.split(',').includes(network.Subnet) && !network.PublicIp));
let directOrigin;
try {
  const response = await fetch(`http://${outputs.AlbDnsName}/healthz`, { signal: AbortSignal.timeout(4000) });
  directOrigin = { status: response.status };
  assert.equal(response.status, 403);
} catch (error) {
  if (!['TimeoutError', 'AbortError'].includes(error.name)) throw error;
  directOrigin = { timedOut: true };
}
const privateControlResponse = await fetch(`${SITE_URL}/_publication/control.json`, {
  redirect: 'manual', signal: AbortSignal.timeout(10_000),
});
const privateControlStatus = privateControlResponse.status;
await privateControlResponse.body?.cancel();
assert.ok([403, 404].includes(privateControlStatus), 'CloudFront must not serve private publication control content.');
const report = {
  checkedAt: new Date().toISOString(), stackStatus: first.stack, siteUrl: outputs.SiteUrl,
  distribution: first.distribution, vpc: second.loadBalancer.VpcId,
  customDomain: {
    hostname: SITE_HOSTNAME, aliases: first.distribution.Aliases,
    viewerCertificate: first.distribution.ViewerCertificate,
    certificate: { region: CERTIFICATE_REGION, ...second.certificate },
    redirectFunction: {
      arn: canonicalFunctionArn, eventType: 'viewer-request',
      behaviorPaths: canonicalBehaviors.map(behavior => behavior.Path),
    },
    staticRouterFunction: {
      arn: staticRouterArn, eventType: 'viewer-request',
      behaviorPaths: staticBehaviors.map(behavior => behavior.Path),
    },
    applicationUrls: {
      web: { publicBaseUrl: webEnvironment.get('PUBLIC_BASE_URL'), publicOrigin: webEnvironment.get('PUBLIC_ORIGIN') },
      collector: { publicBaseUrl: workerEnvironment.get('PUBLIC_BASE_URL') },
    },
  },
  securityGroups: { alb: albGroup, web: webGroup, worker: outputs.WorkerSecurityGroupId, cloudFrontPrefixList: 'pl-22a6434b' },
  networks, webTaskArns: liveTasks.map(task => task.taskArn), guardDutyRunning: true,
  healthyTargets: second.targets.filter(target => target.TargetHealth.State === 'healthy').length,
  cacheTtl: { min: 0, default: 0, max: 60 }, directOrigin, originTokenMatched,
  collector: { modelId, taskDefinition: outputs.WorkerTaskDefinitionArn, modelPolicyVerified: true,
    siteBucket: outputs.SiteBucketName, staticDirectory: workerEnvironment.get('STATIC_DIR'), sitePublicationGrantsVerified: true },
  schedule: { name: outputs.ScheduleName, expression: first.schedule.ScheduleExpression, timezone: first.schedule.ScheduleExpressionTimezone, state: first.schedule.State, workerNetwork },
  storage: { bucket: outputs.DataBucketName, publicAccessBlocked: true, encryption: 'AES256', versioning: 'Enabled',
    site: { bucket: outputs.SiteBucketName, publicAccessBlocked: true, policyPublic: false,
      encryption: 'AES256', versioning: 'Enabled', objectOwnership: 'BucketOwnerEnforced' } },
  staticDelivery: {
    enabled: true, defaultRootObject: first.distribution.DefaultRootObject,
    origin: { id: staticOrigin.Id, domain: staticOrigin.Domain },
    oac: { id: staticOrigin.OacId, type: second.oac.OriginAccessControlOriginType,
      signingProtocol: second.oac.SigningProtocol, signingBehavior: second.oac.SigningBehavior },
    privateControl: { prefix: '/_publication/*', cloudFrontPolicyDenyVerified: true, httpStatus: privateControlStatus },
    iam: { collectorReadWrite: true, collectorListBucket: true, collectorDelete: false, webSiteAccess: false },
    immutableCachePolicy: IMMUTABLE_CACHE_POLICY, customCachePolicyCount: cacheResources.length,
  },
  presence: {
    table: {
      name: outputs.PresenceTableName, arn: first.presenceTable.TableArn, status: first.presenceTable.TableStatus,
      keys: { partition: 'pk', sort: 'sk' }, billingMode: first.presenceTable.BillingModeSummary.BillingMode,
      ttl: { attribute: first.presenceTtl.AttributeName, status: first.presenceTtl.TimeToLiveStatus },
      pointInTimeRecovery: first.presenceBackups.PointInTimeRecoveryDescription.PointInTimeRecoveryStatus,
      encryption: { status: first.presenceTable.SSEDescription.Status, type: first.presenceTable.SSEDescription.SSEType },
    },
    cloudFront: {
      path: '/api/presence', cachePolicy: presenceBehavior.CachePolicy, originRequestPolicy: presenceBehavior.OriginPolicy,
      allowedMethods: presenceBehavior.Methods, cacheTtl: { min: 0, default: 0, max: 0 },
      viewerHeaders: 'allViewer', cookies: 'all', queryStrings: 'all',
    },
    webConfiguration: { table: outputs.PresenceTableName, publicOrigin: siteOrigin, signingSecretReferenceVerified: true },
    identityPolicies: {
      webRole: webRoleName, allowedActions: PRESENCE_ACTIONS, tableArn: first.presenceTable.TableArn,
      collectorRole: workerRoleName, collectorDynamoAllowPermissions: false, includedManagedPolicies: true,
    },
  },
};
await writeFile(options.output, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report));

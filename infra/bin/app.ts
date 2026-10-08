import { App, Aspects } from 'aws-cdk-lib';
import { AwsSolutionsChecks } from 'cdk-nag';
import { CodePulseStack } from '../lib/stack.js';

const app = new App();
new CodePulseStack(app, 'CodePulse', {
  env: { account: '061525506239', region: 'ap-northeast-2' },
  description: 'Code Pulse official changelog briefings on the existing VPC',
});
Aspects.of(app).add(new AwsSolutionsChecks({ verbose: true }));
app.synth();

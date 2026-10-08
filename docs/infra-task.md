# AWS 구현 지시

작업 폴더는 /home/ec2-user/my-project/code-assistant-changelog 이다. docs/superpowers/specs/2026-10-07-code-pulse-design.md와 계획의 Task 3를 읽는다. 빈 폴더에서 시작한 새 프로젝트이며 .git는 환경이 보호한다. Git 작업은 하지 않는다.

수정 범위: infra/**, cdk.json, cdk.context.json, Dockerfile, .dockerignore, tests/infra.test.ts, docs/infra-report.md. package.json과 애플리케이션 코드는 부모가 관리한다. 필요한 변경은 부모에게 알린다.

사용 가능한 패키지는 aws-cdk-lib 2.272.0, aws-cdk, constructs, cdk-nag다. 계정 061525506239의 ap-northeast-2에 배포한다. 부모가 기존 VPC와 서브넷을 AWS API로 확인했다.

- VPC: vpc-0dfa5610180dfa628, CIDR 10.100.0.0/16
- CloudFront origin-facing Prefix List: pl-22a6434b
- 퍼블릭 서브넷: subnet-08486a1e618b1991e (ap-northeast-2a), subnet-0c161777c4031c320 (ap-northeast-2b)
- 프라이빗 서브넷: subnet-07b1e65682847dce9 (ap-northeast-2a), subnet-095297380cd45e1eb (ap-northeast-2b)
- 기존 NAT와 S3 엔드포인트를 사용한다.

VPC.fromVpcAttributes로 검증한 서브넷을 명시적으로 가져오거나 기존 게임 사이트의 lookup 패턴을 사용한다. 새 VPC, NAT, 라우트와 엔드포인트를 만들지 않는다. 기존 게임 사이트는 읽기만 할 수 있다. 참고 파일은 /home/ec2-user/my-project/clawd-game/infra/lib/constructs/{service,edge,network}.ts와 cdk.context.json이다.

웹 서비스 구성:

- CloudFront HTTPS → 퍼블릭 ALB HTTP 80 → 프라이빗 ECS Fargate 8080.
- ALB SG는 pl-22a6434b에서 오는 80번만 허용한다. listener open:false. 기본 응답 403.
- Secrets Manager가 생성한 전용 헤더 값을 CloudFront가 붙이고 ALB listener rule이 검사한다. 평문 비밀을 코드, 출력 또는 환경변수에 넣지 않는다.
- ALB egress는 웹 SG의 8080만 허용한다. 웹 SG는 ALB SG의 8080만 인바운드 허용하며 아웃바운드 443을 사용한다.
- ARM64, Node 22, 256 CPU, 512 MiB, desiredCount 1, public IP 비활성. 최소 1, 최대 2 오토스케일.
- /healthz로 건강 확인. Circuit breaker와 rollback.
- 컨테이너의 기본 명령은 node dist/server/index.js.

데이터와 수집:

- 버전 관리, SSE-S3, 공개 차단, enforceSSL을 적용한 비공개 S3 버킷. 삭제 시 RETAIN. raw/ 자료에는 적절한 수명 주기를 적용한다.
- 웹 task role은 published/* 읽기만 허용한다.
- 별도 ARM64 수집 task definition: 512 CPU, 1024 MiB, 동일 이미지, command ["node", "dist/collector/run.js"]. containerName은 collector. 인바운드 없는 SG, 443 egress, 프라이빗 서브넷, public IP 비활성.
- 환경변수: DATA_BUCKET, AWS_REGION=ap-northeast-2, BEDROCK_MODEL_ID=global.anthropic.claude-haiku-4-5-20251001-v1:0, ENABLE_METRICS=true. 웹에는 모델 권한을 주지 않는다.
- 수집 task role은 published/snapshot.json 읽기/쓰기와 raw/* 쓰기, 필요한 경우 버킷 조회만 허용한다.
- Bedrock InvokeModel은 이 추론 프로필과 해당 Haiku 4.5 foundation model로 제한한다. 글로벌 추론의 리전 와일드카드는 필요하지만 모델 와일드카드는 쓰지 않는다. 모델 호출은 부모가 실제로 확인했다.
- EventBridge Scheduler: cron(0 9 * * ? *), timezone Asia/Seoul, flexible window OFF, ECS RunTask, taskCount 1. Scheduler 전용 role은 이 worker task만 실행하고 이 두 task role만 PassRole하도록 제한한다.
- Scheduler 재시도와 SQS DLQ를 구성한다. DLQ는 TLS를 강제한다.
- 수집 프로세스는 20분 뒤 종료한다. 중간 결과는 매 5개 항목마다 저장하고, 14분 뒤에는 새 해설 생성을 멈추고 남은 항목을 pending으로 보존한다.

관측:

- 웹과 수집 CloudWatch Logs, 14일 보존.
- 수집기가 EMF로 Namespace=CodePulse, Dimension Application=code-pulse, CollectionSuccess와 CollectionFailure Count를 출력한다.
- 수집 실패, 매일 성공 지표 누락, ALB 5xx, healthy target 부족, DLQ 메시지 알람을 구성한다. SNS 메일/메시지를 보내지 않는다.
- CloudFront는 API 캐시를 최대 60초까지만 허용하고 오류를 200으로 바꾸지 않는다. 정적 해시 파일과 fonts는 길게 캐시한다.
- 앱 CSP는 script-src/style-src/font-src 'self'다. 글꼴은 자체 호스팅이다. CloudFront에서 다른 CSP로 덮지 않아도 된다.

CloudFront 기본 도메인을 접속 주소로 사용한다. 사용자 도메인은 아직 선택되지 않았다.

필수 출력: SiteUrl, DistributionId, DistributionDomainName, AlbDnsName, ClusterName, ServiceName, WorkerTaskDefinitionArn, WorkerSecurityGroupId, PrivateSubnetIds, DataBucketName, ScheduleName, WebLogGroupName, CollectorLogGroupName. PrivateSubnetIds는 쉼표로 연결한다.

도커는 프로젝트 루트에서 npm ci와 npm run build로 만들고 실행 이미지는 npm ci --omit=dev, dist만 포함한다. 빌드는 ARM64로 설정한다. node 사용자, 읽기 전용 root filesystem이 가능해야 한다. .dockerignore에 .git, .agents, .codex, .aws, node_modules, data, docs, cdk.out, dist, test-results 등 개발 산출물을 제외한다. package-lock.json은 포함한다.

검증:

1. CDK assertions로 VPC/NAT 신규 생성 없음, Prefix List만 인바운드, 태스크 공인 IP 비활성, 스케줄, 웹/수집 권한 분리, 버킷 공개 차단을 검사한다.
2. cdk-nag AwsSolutionsChecks 또는 동등한 보안 검사를 실행한다. 불가피한 검사 예외는 리소스별로 근거를 기록한다. 일괄 무시하지 않는다.
3. 타입 검사, infra 단위 테스트와 synth를 실행한다. 실제 deploy는 부모가 수행한다.

하위 에이전트를 만들지 않는다. 보고서는 docs/infra-report.md에 남기고 부모에게 결과를 알린다.

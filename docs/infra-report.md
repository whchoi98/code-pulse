# Code Pulse 인프라 구현 보고서

2026-10-07에 계정 `061525506239`, 리전 `ap-northeast-2`를 대상으로 CDK 구현과 로컬 검증을 진행했다. 이 작업에서는 AWS 리소스를 배포하지 않았다. 외부 작업은 공식 문서와 기존 라우트 테이블의 읽기 전용 조회였다.

구현 파일은 `infra/bin/app.ts`, `infra/lib/stack.ts`, `cdk.json`, `cdk.context.json`, `Dockerfile`, `.dockerignore`, `tests/infra.test.ts`다. 애플리케이션과 패키지 파일은 부모 작업에서 관리한다.

| 구간 | 구현 |
| --- | --- |
| 요청 경로 | CloudFront HTTPS → 기존 퍼블릭 서브넷의 ALB HTTP 80 → 기존 프라이빗 서브넷의 Fargate 8080 |
| ALB 접근 | CloudFront Prefix List `pl-22a6434b`만 인바운드 허용, 기본 403, Secrets Manager 전용 헤더 확인 |
| ALB 아웃바운드 | 웹 보안 그룹의 8080만 허용 |
| 웹 태스크 | ARM64, 256 CPU, 512 MiB, 기본 1개, 확장 범위 1~2개, 공인 IP 없음 |
| 수집 태스크 | ARM64, 512 CPU, 1024 MiB, 인바운드 없음, 공인 IP 없음, HTTPS 아웃바운드 |
| 실행 이미지 | Node 22, 동일 Docker 이미지, `node` 사용자, 읽기 전용 루트 파일시스템 |
| 건강 확인 | `/healthz`, ECS 배포 circuit breaker와 rollback |
| 데이터 | 비공개 S3, SSE-S3, 버전 관리, 공개 차단, TLS 강제, 삭제 시 보존 |
| 수집 일정 | `cron(0 9 * * ? *)`, `Asia/Seoul`, flexible window OFF, 한 번에 태스크 1개 |
| 실패 처리 | Scheduler 최대 재시도 2회, 이벤트 최대 수명 1시간, TLS와 SSE-SQS를 적용한 DLQ, 메시지 14일 보존 |
| 로그 | 웹과 수집 로그 그룹 각각 14일 보존 |
| 알람 | 수집 실패, 일일 성공 지표 누락, ALB 5xx, 대상 5xx, healthy target 부족, DLQ 메시지 |
| 캐시 | 읽기 API 최대 60초, `/assets/*`와 `/fonts/*` 장기 캐시, 오류 상태 유지 |

VPC와 서브넷은 `Vpc.fromVpcAttributes`로 가져온다. 조회 결과를 명시했으므로 AWS 자격 증명 없이 합성할 수 있고 `cdk.context.json`에는 lookup 데이터가 필요 없다. 기존 NAT와 S3 엔드포인트를 재사용하며 새 VPC, 서브넷, NAT, 라우트, 라우트 테이블, 엔드포인트를 만들지 않는다.

| 용도 | 서브넷 | 확인한 라우트 테이블 |
| --- | --- | --- |
| 퍼블릭 2a | `subnet-08486a1e618b1991e` | `rtb-01d918b95384379e7` |
| 퍼블릭 2b | `subnet-0c161777c4031c320` | `rtb-032d073e28d5a0afd` |
| 프라이빗 2a | `subnet-07b1e65682847dce9` | `rtb-0cc7d19bb484c49ef` |
| 프라이빗 2b | `subnet-095297380cd45e1eb` | `rtb-021c674ad5e43276f` |

웹 태스크 역할은 이 버킷의 `published/*`에 대한 `s3:GetObject`만 허용한다. 모델 호출, 저장, 삭제, 버킷 조회 권한은 없다. 수집 태스크 역할은 `published/snapshot.json` 읽기와 쓰기, `raw/*` 쓰기, 해당 버킷의 `s3:ListBucket`을 허용한다. 빈 버킷의 첫 수집에서 없는 스냅샷을 `NoSuchKey`로 확인하려면 버킷 조회 권한이 필요하다. 이 권한이 없으면 S3가 403을 반환한다.

모델 권한은 `bedrock:InvokeModel` 하나다. 추론 프로필은 `global.anthropic.claude-haiku-4-5-20251001-v1:0`으로 고정했다. foundation model의 리전만 `*`이며 모델 이름은 `anthropic.claude-haiku-4-5-20251001-v1:0`으로 제한했다. `bedrock:InferenceProfileArn` 조건으로 해당 프로필을 통한 호출만 허용한다. 공식 문서의 글로벌 추론 예시는 호출 리전과 리전이 없는 foundation model ARN을 함께 사용한다. 리전 와일드카드는 두 형식을 포함한다.

웹과 수집 태스크는 별도 실행 역할도 사용한다. 실행 역할의 ECR 다운로드와 로그 쓰기는 각 저장소와 로그 그룹으로 제한했다. 리소스 범위를 지원하지 않는 ECR `GetAuthorizationToken`만 `Resource: "*"`를 사용한다. Scheduler 역할은 이 수집 태스크 정의만 실행하고 수집 태스크 역할과 수집 실행 역할만 전달한다. 신뢰 정책의 `aws:SourceArn`은 전용 schedule group으로 제한했다.

Secrets Manager가 생성하는 48자 헤더 값은 CloudFormation 동적 참조로만 템플릿에 들어간다. 태스크 환경변수와 스택 출력에 이 값을 넣지 않았다. CloudFront는 앱의 CSP를 덮어쓰지 않는다.

원문은 90일 뒤 만료되고 이전 버전은 30일 뒤 만료된다. 공개 스냅샷의 현재 버전은 유지하며 이전 버전만 30일 뒤 정리한다. 미완료 multipart 업로드는 하루 뒤 정리한다. 데이터 버킷과 함께 원본 확인용 비밀, 로그 그룹, DLQ도 스택 삭제 시 보존한다.

수집기의 20분 실행 제한, 14분 이후 새 해설 생성 중단, 5개 항목마다 중간 저장은 애플리케이션 실행 경로에서 담당한다. 수집 태스크는 `node dist/collector/run.js`로 이 경로를 실행한다. `ENABLE_METRICS=true`로 EMF를 활성화하며 `CodePulse` namespace와 `Application=code-pulse` dimension을 사용하는 알람을 연결했다. SNS와 메시지 발송 작업은 추가하지 않았다.

Scheduler DLQ는 태스크 시작 요청의 실패를 저장한다. 실행이 시작된 뒤의 수집 오류는 수집 실패 지표와 로그에서 확인한다. 지표를 내기 전에 프로세스가 중단되면 일일 성공 지표 누락 알람으로 확인한다. 첫 수집 전에는 성공 지표가 없으므로 해당 알람이 ALARM 상태가 될 수 있다.

출력은 `SiteUrl`, `DistributionId`, `DistributionDomainName`, `AlbDnsName`, `ClusterName`, `ServiceName`, `WorkerTaskDefinitionArn`, `WorkerSecurityGroupId`, `PrivateSubnetIds`, `DataBucketName`, `ScheduleName`, `WebLogGroupName`, `CollectorLogGroupName`을 제공한다. `PrivateSubnetIds`는 쉼표로 연결했다. 운영 조회를 위해 `ScheduleGroupName`과 `SchedulerDeadLetterQueueUrl`도 제공한다. 일정 조회 시 `--group-name code-pulse`를 함께 사용한다.

테스트를 먼저 작성하고 리소스가 없는 초기 스택에서 14개 기능 테스트의 실패를 확인한 뒤 구현했다. 빈 버킷 초기화 권한과 서브넷 import 경고도 실패하는 검증을 먼저 확인했다.

| 검증 | 결과 |
| --- | --- |
| `npm run typecheck` | 최초 통과. 패키지 갱신 뒤 Node 22 최종 검사에서 부모 소유 파일 `src/server/app.ts:101`의 `setHeader` 타입 오류 확인 |
| `npm test -- tests/infra.test.ts --reporter=dot` | Node 22에서 15개 통과 |
| `npm run synth -- --no-lookups` | Node 22에서 통과, construct 경고 없음 |
| CDK 기본 CloudFormation 검증 | 통과 |
| `AwsSolutionsChecks` | Compliant 29개, 리소스별 Suppressed 16개, 미해결 항목 0개 |
| Docker asset 검사 | `linux/arm64`, `package-lock.json`과 빌드 도구 포함, 개발 및 자격 증명 디렉터리 제외 확인 |
| `docker build --platform linux/arm64 --tag code-pulse:infra-verify .` | 통과 |
| Docker 이미지 설정 확인 | `linux/arm64`, 사용자 `node`, 명령 `["node", "dist/server/index.js"]` |
| 실행용 의존성 검사 | 이미지의 `npm ci --omit=dev`에서 취약점 0개 |
| AWS 배포와 실제 태스크 실행 | 부모 작업의 배포 단계에서 확인 |

확인한 로컬 이미지 태그는 `code-pulse:infra-verify`이며 ID는 `sha256:80d7afcf4ed80c189a7405453e899d4029d903caa669a17b71b8f3d7bb849b22`다. 이미지 빌드에는 패키지 잠금 파일과 최신 `@fastify/static` 10.1.5가 반영됐다. 빌드 단계 전체 의존성 설치에서는 개발 의존성 취약점 4개가 보고됐다. 분류는 중간 1개, 높음 1개, 치명적 2개이며 부모 작업이 별도로 검토한다.

인계 당시 남은 애플리케이션 문제는 `@fastify/static` 10의 `setHeaders` 콜백이다. 새 버전이 전달하는 `FastifyReply`에 기존 `setHeader`를 호출해 타입 검사가 실패한다. 부모 작업이 이 콜백과 실제 정적 파일 응답의 회귀 테스트를 수정한다. 이 이미지에는 해당 수정 전 코드가 들어 있으므로 수정 후 배포 이미지 빌드와 컨테이너 실행 검증이 필요하다. 인프라 작업에서는 Docker 빌드와 이미지 설정 확인까지만 수행했다.

cdk-nag의 예외는 다음 리소스에만 적용했다. IAM5는 `appliesTo`로 허용할 리소스 패턴도 좁혔다. 스택 전체 예외는 없다.

| 규칙 | 대상과 근거 |
| --- | --- |
| S1 | 데이터 버킷. 초기 공개 자료 서비스의 별도 S3 접근 로그를 생략하고 수집 결과와 오류를 CloudWatch에 남긴다. |
| SMG4 | OriginToken. CloudFront와 ALB 헤더를 함께 갱신해야 하므로 비밀만 자동 교체하지 않는다. 교체 시 두 리소스를 포함한 배포를 수행한다. |
| ELB2 | ALB. 별도 S3 접근 로그를 생략하고 앱 요청 로그와 ALB 지표를 사용한다. |
| CFR1 | Distribution. 공개 변경 기록이므로 국가 제한을 두지 않는다. |
| CFR2 | Distribution. 초기 비용 범위에서 WAF를 생략한다. GET과 HEAD만 제공하며 원본 접근과 웹 권한을 제한했다. |
| CFR3 | Distribution. 별도 CloudFront 접근 로그를 생략하고 앱 요청 로그와 원본 상태 알람을 사용한다. |
| CFR4 | Distribution. 사용자 도메인이 정해지지 않아 CloudFront 기본 인증서를 사용한다. 모든 동작에서 HTTPS로 리디렉션한다. |
| CFR5 | Distribution. 승인된 기존 사이트 구성과 같은 HTTP 원본 경로를 사용한다. Prefix List와 전용 헤더로 ALB 접근을 제한한다. |
| ECS2 | 웹과 수집 태스크. 환경변수에는 버킷, 리전, 공개 URL, 모델 ID, 실행 설정만 있다. |
| IAM5 | 웹의 `published/*`, 수집의 `raw/*`, 정확한 글로벌 Haiku 모델 ARN, 두 실행 역할의 ECR 인증 토큰만 예외로 둔다. |
| SQS3 | Scheduler DLQ. 실패를 마지막으로 보관하는 큐이므로 추가 DLQ를 연결하지 않는다. 메시지 알람과 14일 보존을 적용했다. |

비용은 부모 작업이 구현 전에 2026-10-07 AWS Pricing API로 확인해 사용자에게 안내했다. 서울 ARM vCPU는 시간당 USD 0.03725, ARM 메모리는 GiB당 시간당 USD 0.00409, ALB는 시간당 USD 0.0225와 LCU당 시간당 USD 0.008이었다. 월 730시간을 가정한 기본 웹 태스크는 약 USD 8.29, ALB 기본 요금은 약 USD 16.43이다. 공인 IPv4, 트래픽, 수집 태스크, S3, 로그와 Container Insights, 알람, Secrets Manager, 모델 호출은 별도다. 기존 NAT를 재사용하며 새 NAT의 고정 비용은 추가하지 않는다.

확인한 공식 문서는 다음과 같다. 조회일은 2026-10-07이다.

- Bedrock 추론 프로필 권한: `https://docs.aws.amazon.com/bedrock/latest/userguide/inference-profiles-prereq.html`
- Scheduler ECS 매개변수: `https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-properties-scheduler-schedule-ecsparameters.html`
- Scheduler 역할의 SourceArn 범위: `https://docs.aws.amazon.com/scheduler/latest/UserGuide/cross-service-confused-deputy-prevention.html`
- CloudFront와 ALB 접근 제한: `https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/restrict-access-to-load-balancer.html`
- S3 GetObject와 없는 키의 응답: `https://docs.aws.amazon.com/AmazonS3/latest/API/API_GetObject.html`

2026-10-07 독립 검토 후 `docs/infra-review.md`의 P2 두 항목을 수정했다. 이번 변경 범위는 `infra/lib/stack.ts`, `tests/infra.test.ts`와 이 보고서의 추가 기록이다.

성공 누락 알람에 `EvaluationWindow: { WallClockWindow: { Timezone: "UTC" } }`를 설정했다. `Period=86400`, `EvaluationPeriods=1`, `Sum`, 임계치 1과 누락 시 breaching 설정은 유지한다. 알람은 UTC 자정 이후 직전에 완료된 UTC 하루를 평가하며, 더 오래된 성공 지표로 빈 구간을 보충하지 않는다. 예를 들어 UTC 기준 10월 7일에 성공 기록이 없으면 10월 8일 00:00 UTC, 한국 시각 09:00 이후 평가에 반영한다. 현재 수집이 끝나는 즉시 감지하는 알람은 아니며, 실행 중 보고되는 실패는 별도의 수집 실패 알람이 담당한다.

웹 서비스에는 `webService.node.addDependency(webExecutionRole)`를 추가했다. 합성된 `WebService7F8A1763.DependsOn`에 `WebExecutionRoleE06F8825`와 `WebExecutionRoleDefaultPolicyFC8EC453`이 모두 포함되는 것을 확인했다. 이 의존성은 서비스 생성 전에 ECR 다운로드와 로그 권한이 준비되고, 삭제할 때에는 서비스가 제거될 때까지 정책이 유지되도록 한다.

두 회귀 테스트는 실제 합성 템플릿에서 완료된 UTC 하루의 평가 설정과 웹 실행 역할 정책의 의존성을 검사한다. 의존성 검사는 배열의 순서에 의존하지 않는다.

| 추가 검증 | 결과 |
| --- | --- |
| 수정 전 전체 인프라 테스트 | 기존 15개 통과, 새 테스트 2개 실패. 평가 창과 실행 역할 의존성 누락을 각각 확인 |
| 실행 역할 의존성 수정 후 해당 테스트 | 1개 통과 |
| 두 수정 후 인프라 테스트 | Node 22와 Vitest 4.1.11에서 17개 통과 |
| `npm run synth -- --no-lookups` | 통과 |
| cdk-nag | Compliant 29개, 기존 Suppressed 16개, 미해결 항목 0개 |

이번 후속 작업에서는 Docker 빌드와 배포를 반복하지 않았다. 앞서 기록한 Fastify 콜백 문제와 실제 정적 응답 회귀 테스트는 부모 작업에서 해결했다는 결과를 전달받았다. 전체 애플리케이션의 최종 검증과 배포는 부모 작업에서 이어간다.

이번 수정은 다음 공식 문서를 2026-10-07에 다시 읽고 확인했다.

- CloudWatch 평가 창과 완료된 기간의 경계: `https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/alarm-evaluation-window.html`
- 누락 지표와 과거 데이터 조회 범위: `https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/alarms-and-missing-data.html`
- IAM 역할에 별도로 연결된 정책의 의존성: `https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-resource-iam-role.html`

2026-10-07 부모 작업의 실제 배포에서 `ApiCache` 생성이 CloudFront 커스텀 캐시 정책 한도로 실패했다. 부모 작업의 읽기 전용 조회 결과, 기존 정책은 19개이고 해당 계정 한도는 20개라 새 정책을 하나만 추가할 수 있었다. 이번 수정에서는 자체 커스텀 정책을 두 개에서 하나로 줄였다.

기존 `HtmlCache346E2E09` 논리 ID와 정책 이름을 유지하고 중복 `ApiCache` 리소스를 제거했다. 기본 HTML 동작과 `/api/*`가 같은 정책을 참조한다. 공유 정책은 `MinTTL=0`, `DefaultTTL=0`, `MaxTTL=60`, cookies와 headers `none`, query strings `all`, gzip과 Brotli 활성화로 설정했다. HTML의 원본 `no-cache` 응답은 계속 재검증하며 API의 `s-maxage`는 최대 60초로 제한된다. `/assets/*`와 `/fonts/*`의 관리형 장기 캐시 정책, `/healthz`의 캐시 비활성 정책, HTTPS 및 오류 상태 처리는 기존 설정을 유지한다.

| 캐시 정책 수정 검증 | 결과 |
| --- | --- |
| RED | 기존 17개 통과, 새 테스트 2개 실패. 커스텀 정책 2개 생성과 HTML/API의 서로 다른 정책 참조를 확인 |
| GREEN | Node 22와 Vitest 4.1.11에서 인프라 테스트 19개 통과 |
| `npm run synth -- --no-lookups` | 통과 |
| 합성 결과 | 커스텀 정책 1개. 기본 HTML과 `/api/*` 모두 `HtmlCache346E2E09` 참조 |
| cdk-nag | Compliant 29개, 기존 Suppressed 16개, 미해결 항목 0개 |

수정 파일은 `infra/lib/stack.ts`, `tests/infra.test.ts`와 이 보고서의 추가 기록으로 제한했다. 이 후속 작업에서는 다른 앱의 정책을 수정하거나 삭제하지 않았으며, AWS 변경과 Docker 빌드를 수행하지 않았다. 실패한 배포의 실제 rollback 상태 확인과 재배포는 부모 작업에서 진행한다.

2026-10-07 실제 Fargate 통합 검증에서 계정 설정이 자동으로 추가한 GuardDuty 컨테이너의 이미지 다운로드 실패를 확인했다는 결과를 부모 작업에서 전달받았다. 웹 애플리케이션은 실행 중이고 사이트는 200을 반환했지만, `aws-guardduty-agent`는 서울 리전 저장소의 ECR HEAD 요청에서 403을 받아 중단된 상태였다.

공식 GuardDuty 요구사항과 리전별 저장소 표를 읽고 웹 실행 역할과 수집 실행 역할에 다음 저장소의 이미지 읽기 권한만 추가했다.

```text
arn:aws:ecr:ap-northeast-2:914738172881:repository/aws-guardduty-agent-fargate
```

허용 작업은 `ecr:BatchCheckLayerAvailability`, `ecr:GetDownloadUrlForLayer`, `ecr:BatchGetImage` 세 개다. 기존 `ecr:GetAuthorizationToken`의 `Resource: "*"` 권한을 재사용하며 중복 추가하지 않았다. 넓은 ECR 관리형 정책과 태스크 역할의 ECR 권한은 추가하지 않았다. VPC와 GuardDuty 설정은 변경하지 않았다.

합성된 `WebExecutionRoleDefaultPolicyFC8EC453`과 `WorkerExecutionRoleDefaultPolicy2AE0C78C`에서 각기 위 정확한 저장소 ARN과 세 작업을 확인했다. 기존 ECR 인증 토큰의 cdk-nag 예외 사유에는 앱 이미지 저장소와 서울 GuardDuty 저장소의 제한을 함께 기록했다.

| GuardDuty 권한 수정 검증 | 결과 |
| --- | --- |
| RED | 기존 19개 통과, 웹과 수집 실행 역할의 새 범위 검사 2개 실패. GuardDuty 저장소 읽기 권한 누락을 확인 |
| GREEN | Node 22와 Vitest 4.1.11에서 인프라 테스트 21개 통과 |
| 권한 범위 | 정확한 서울 저장소 ARN, 읽기 작업 3개, 기존 인증 토큰 권한 1개, 관리형 정책 없음, 태스크 역할 ECR 권한 없음 |
| `npm run synth -- --no-lookups` | 통과 |
| 공유 캐시 정책 | 커스텀 정책 1개 유지, HTML과 API의 공유 및 TTL 검사 통과 |
| cdk-nag | Compliant 29개, 기존 Suppressed 16개, 미해결 항목 0개 |

이번 변경은 `infra/lib/stack.ts`, `tests/infra.test.ts`와 보고서의 추가 기록으로 제한했다. 배포와 Docker 작업은 수행하지 않았다. 부모 작업이 정책을 배포한 뒤 새 웹 및 수집 태스크에서 GuardDuty 상태를 확인한다.

공식 문서 조회일은 2026-10-07이다.

- GuardDuty Fargate의 실행 역할 이미지 접근 권한: `https://docs.aws.amazon.com/guardduty/latest/ug/prereq-runtime-monitoring-ecs-support.html`
- 리전별 GuardDuty 에이전트 ECR 저장소: `https://docs.aws.amazon.com/guardduty/latest/ug/ecs-runtime-agent-ecr-image-uri.html`

2026-10-07 사용자의 Haiku 5.5 전환 요청에 따라 수집 태스크의 `BEDROCK_MODEL_ID`를 `global.anthropic.claude-haiku-5-5`로 변경했다. 부모 작업이 `get-inference-profile`에서 이 프로필의 `ACTIVE` 상태와 서울 리전의 정확한 프로필 ARN을 확인한 결과를 기준으로 구현했다.

수집 역할의 `bedrock:InvokeModel` 대상은 다음 두 범위로 제한한다.

- 추론 프로필: `arn:aws:bedrock:ap-northeast-2:061525506239:inference-profile/global.anthropic.claude-haiku-5-5`
- foundation model: `arn:aws:bedrock:*::foundation-model/anthropic.claude-haiku-5-5`

foundation model의 리전 와일드카드는 기존 글로벌 추론 동작을 유지한다. 모델 ID에는 와일드카드를 쓰지 않으며, `bedrock:InferenceProfileArn` 조건은 위 Haiku 5.5 프로필과 정확히 일치해야 한다. Haiku 4.5의 권한과 환경변수 fallback은 남기지 않았다. 합성된 템플릿 전체에 이전 `claude-haiku-4-5` 모델 식별자가 없는 것도 확인했다.

| Haiku 5.5 전환 검증 | 결과 |
| --- | --- |
| RED | 기존 코드에서 변경한 모델 경계 검사 2개 실패, 나머지 19개 통과. 환경변수와 IAM이 여전히 Haiku 4.5인 것을 확인 |
| GREEN | Node 22와 Vitest 4.1.11에서 인프라 테스트 21개 통과 |
| 관련 TypeScript 검사 | `infra/bin/app.ts`, `infra/lib/stack.ts`, `tests/infra.test.ts`를 strict 설정으로 검사해 통과 |
| `npm run synth -- --no-lookups` | 통과 |
| 모델 경계 | 정확한 Haiku 5.5 프로필, 단일 foundation model, 동일 프로필 조건, 이전 4.5 식별자 없음 |
| 기존 구성 | GuardDuty의 정확한 저장소 읽기 권한, 커스텀 캐시 정책 1개, 프라이빗 네트워크 검사 통과 |
| cdk-nag | Compliant 29개, 기존 Suppressed 16개, 미해결 항목 0개 |

변경 범위는 `infra/lib/stack.ts`, `tests/infra.test.ts`와 이 보고서의 추가 기록이다. 이번 작업에서는 배포와 패키지 변경을 수행하지 않았다. 해설기의 기본 모델과 API 호환성, 선택적 해설 재생성 동작 및 실제 모델 호출 검증은 부모 작업과 별도 백엔드 작업에서 담당한다.

2026-10-07 방문 집계 요청에 따라 전용 DynamoDB 테이블과 웹 컨테이너의 설정을 추가했다. 테이블은 문자열 `pk`와 `sk` 복합 키, `expires_at` TTL, `PAY_PER_REQUEST`, AWS 관리형 키 암호화, PITR와 `RETAIN`을 사용한다. TTL 삭제는 백그라운드에서 이루어지므로 현재 접속자의 90초 판정은 백엔드가 수행한다.

웹 태스크 역할에는 이 테이블 ARN의 `dynamodb:GetItem`, `dynamodb:PutItem`, `dynamodb:UpdateItem`, `dynamodb:Query`만 추가했다. 공식 문서에 따라 `TransactWriteItems`의 Put과 Update는 각각 `PutItem`과 `UpdateItem` 권한으로 허가된다. `dynamodb:TransactWriteItems`라는 별도 IAM 작업은 넣지 않았다. Put과 Update의 `ConditionExpression`에도 같은 권한을 사용한다. 별도 `ConditionCheck` 작업에 필요한 `ConditionCheckItem`은 현재 구성에 포함하지 않는다.

게시물 S3 권한은 `published/*` 읽기를 유지한다. 수집 태스크와 수집 실행 역할에는 방문 테이블과 방문 비밀의 권한을 추가하지 않았다. 기존 Haiku 5.5 프로필, GuardDuty 저장소 권한과 프라이빗 네트워크 설정도 유지했다.

`PRESENCE_TABLE`은 테이블 이름을 웹 환경변수로 전달한다. `PRESENCE_SECRET`은 원본 검증 토큰과 분리한 48자 Secrets Manager 비밀을 ECS secret으로 주입한다. 비밀은 배포마다 바뀌지 않으며 삭제 시에도 보존한다. ECS 실행 역할만 해당 비밀을 읽을 수 있고, 평문 환경 설정이나 스택 출력에는 비밀 값을 넣지 않는다. 브라우저 식별자가 갑자기 바뀌지 않도록 자동 비밀 교체는 사용하지 않으며, 이 사유로 해당 비밀의 SMG4 예외를 기록했다.

`PUBLIC_ORIGIN`에는 CloudFront의 `SiteUrl`을 전달했다. 기존 `PUBLIC_BASE_URL`과 같은 분배 도메인 참조여서 새 의존성 순환이 없음을 합성으로 확인했다.

CloudFront에는 정확한 `/api/presence` 동작을 `/api/*`보다 앞에 추가했다. 관리형 `CACHING_DISABLED`와 `ALL_VIEWER`를 사용해 캐시를 끄고 Cookie, Origin, Host를 포함한 viewer 헤더를 원본에 전달한다. POST 지원을 위해 CloudFront는 `ALLOW_ALL`을 사용하며, 서버가 GET/POST 제한과 Origin 검증을 담당한다. 기존 `/api/*`는 GET/HEAD와 최대 60초 캐시를 유지한다. 새 커스텀 캐시 정책은 만들지 않아 정책 수는 여전히 하나다.

새 출력 `PresenceTableName`을 추가했다. 추가 리소스 비용은 방문 테이블의 요청, 저장과 PITR, 별도 Secrets Manager 비밀에서 발생한다.

| 방문 집계 인프라 검증 | 결과 |
| --- | --- |
| RED | 방문 권한, 테이블, 비밀 주입, CloudFront 동작과 출력 검사 5개 실패. 기존 19개 통과 |
| GREEN | 인프라 테스트 24개 통과 |
| 타입 검사 | 인프라와 테스트 파일의 strict TypeScript 검사 통과 |
| `npm run synth -- --no-lookups` | 통과, 의존성 순환 없음 |
| cdk-nag | Compliant 30개, 리소스별 Suppressed 17개, 미해결 항목 0개 |
| 권한 분리 | 방문 테이블의 웹 전용 권한, 실행 역할의 비밀 읽기, 수집 역할의 방문 권한 없음 확인 |
| CloudFront | 정확한 경로 우선순위, 캐시 비활성, AllViewer, 기존 읽기 API와 단일 캐시 정책 확인 |

이번 작업은 `infra/lib/stack.ts`, `tests/infra.test.ts`와 이 보고서만 수정했다. AWS 배포와 방문 API의 실제 동작 검증은 부모 작업이 수행한다.

확인한 공식 문서는 다음과 같다.

- DynamoDB 트랜잭션의 IAM 작업: `https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/transaction-apis-iam.html`
- CloudFront AllViewer 관리형 정책: `https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/using-managed-origin-request-policies.html`

## 2026-10-08 공개 도메인 연결

사용자가 연결한 DNS는 `code-pulse.whchoi.net`에서 이 서비스의 `dxdh24n4uucjz.cloudfront.net`을 가리켰다. CloudFront에는 `code-pluse.whchoi.net`이 등록돼 있었다. 발급된 와일드카드 인증서는 유효했지만 요청 도메인과 대체 도메인의 철자가 달라 TLS 연결이 실패했다. 기존 ETag를 조건으로 대체 도메인만 수정했으며, 01:17 UTC에 올바른 별칭의 Deployed 상태와 공개 도메인의 HTTPS 200 응답을 확인했다.

같은 설정을 다음 배포에서도 유지하도록 `infra/lib/stack.ts`에 공개 도메인과 기존 인증서 ARN을 연결했다. 인증서는 `us-east-1`의 `*.whchoi.net` 인증서를 가져오며, 새 인증서나 DNS 리소스를 만들지 않는다. 최소 TLS 정책은 `TLSv1.2_2021`이다. 기본 인증서 사용을 전제로 둔 CFR4 예외는 제거했다.

`SiteUrl`, 두 태스크의 `PUBLIC_BASE_URL`과 웹의 `PUBLIC_ORIGIN`은 `https://code-pulse.whchoi.net`을 사용한다. CloudFront Functions는 기존 도메인의 GET/HEAD 요청을 새 주소로 308 이동시킨다. 경로와 인코딩된 검색 조건, 중복 매개변수를 보존한다. 새 도메인의 요청과 POST는 기존 처리 경로를 유지한다.

이 함수는 모든 캐시 동작의 viewer-request 단계에 연결했다. 사용자 정의 캐시 정책은 하나이며, 방문 API의 캐시 비활성과 Origin 검사, ALB 전용 헤더와 기존 네트워크를 유지한다.

인프라 테스트는 변경 전 새 검사 세 개가 실패했고 변경 후 27개가 통과했다. 전체 단위와 인프라 테스트 346개, 브라우저 테스트 63개, 타입 검사, 빌드와 CDK 합성이 통과했다. cdk-nag 결과는 Compliant 31개, 리소스별 Suppressed 16개, 미해결 항목 0개다. 실제 배포 검증은 `docs/verification.md`, `docs/domain-verification.json`과 `docs/infrastructure-verification.json`에 남긴다.

확인한 AWS 공식 문서는 다음과 같다.

- 대체 도메인과 인증서: `https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/CNAMEs.html`
- CloudFront 인증서 리전: `https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/cnames-and-https-requirements.html`
- CloudFront Functions 요청과 중복 매개변수: `https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/functions-event-structure.html`

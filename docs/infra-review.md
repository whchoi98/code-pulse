# Code Pulse AWS IaC 독립 검토

검토일: 2026-10-07. 검토 대상은 설계서, `docs/infra-task.md`, 구현 보고서, `infra/lib/stack.ts`, `infra/bin/app.ts`, `Dockerfile`, `.dockerignore`, `tests/infra.test.ts`와 현재 합성된 CloudFormation 템플릿이다. 실행 권한과 컨테이너 설정을 확인하기 위해 서버와 수집기의 시작 경로, 저장소 및 Bedrock 호출 코드도 읽었다.

판정: 핵심 배포 구성을 막는 P0/P1 문제는 발견하지 않았다. 배포 전에 아래 P2 두 항목을 수정하는 것을 권고한다. 이 검토는 읽기 전용으로 수행했으며 보고서 외 파일을 수정하거나 AWS 리소스를 배포하지 않았다. 기존 단위 테스트, cdk-nag, synth와 이미지 빌드의 성공은 구현자 보고이며, 부모 작업이 최종 검증을 다시 진행하고 있어 이 검토에서는 넓은 테스트를 반복하지 않았다.

## [IMPORTANT] P2: 일일 누락 알람이 이전 성공 지표를 다시 사용할 수 있음 (confidence: 95)

**File:** `infra/lib/stack.ts:380`, `tests/infra.test.ts:295`

**Issue:** `MissingCollectionSuccessAlarm`은 `Period=86400`, `EvaluationPeriods=1`, `TreatMissingData=breaching`을 사용하지만 `EvaluationWindow`를 지정하지 않는다. 따라서 설명에 적힌 UTC 날짜별 평가가 아니라 기본 sliding window를 사용한다.

CloudWatch의 현재 공식 문서에 따르면 sliding window 알람은 평가 기간보다 오래된 지표도 조회한다. 실제 지표가 `EvaluationPeriods`만큼 있으면 그 지표로 평가하고 누락 데이터 설정을 적용하지 않는다. 이 구성에서는 수집 태스크가 시작된 뒤 지표를 내기 전에 중단되거나 일정이 실행되지 않았을 때, 이전 성공 지표 하나가 현재 실행의 누락을 가릴 수 있다. 단위 테스트는 기간과 임계치만 검사하므로 이 의미 차이를 발견하지 못한다.

**Fix:** 알람의 날짜 경계를 명시한다. 현재 설치된 CDK 2.272.0의 `CfnAlarm`은 `evaluationWindow`를 지원한다. 생성한 알람을 변수에 담은 뒤 다음처럼 설정하면 UTC 날짜가 끝날 때 완료된 하루만 평가하고 더 오래된 지표로 보충하지 않는다.

```ts
(missingSuccessAlarm.node.defaultChild as cloudwatch.CfnAlarm).evaluationWindow = {
  wallClockWindow: { timezone: 'UTC' },
};
```

알람 설명에 완료된 UTC 하루를 평가한다는 점과 감지 시점을 명시하고, 테스트에 `EvaluationWindow: { WallClockWindow: { Timezone: 'UTC' } }` 검증을 추가한다. 현재 실행 종료 직후 감지가 필요하다면 별도의 명시적 확인 시각을 설계해야 한다. 이 수정안은 기존의 일일 집계 의도를 유지한다.

## [IMPORTANT] P2: 웹 서비스가 실행 역할 정책의 적용을 기다리지 않음 (confidence: 85)

**File:** `infra/lib/stack.ts:264`

**Issue:** 웹 실행 역할의 ECR 다운로드와 CloudWatch Logs 권한은 별도의 `AWS::IAM::Policy` 리소스로 생성된다. 현재 템플릿에서 `WebService7F8A1763.DependsOn`에는 원본 listener rule과 웹 task role 및 정책만 있으며 `WebExecutionRoleDefaultPolicyFC8EC453`은 없다. 태스크 정의가 실행 역할 ARN을 참조하는 것만으로는 별도 정책의 적용까지 기다리지 않는다.

따라서 생성이나 관련 설정 갱신 시 서비스 시작과 실행 역할 정책 적용의 순서가 보장되지 않는다. 태스크가 이미지 다운로드나 로그 초기화를 시도하는 동안 필요한 권한이 아직 없을 수 있다. 삭제 시에도 서비스보다 정책이 먼저 제거될 수 있다. 현재 환경에서 실패를 재현한 것은 아니며, 첫 배포의 CloudFront 생성 대기 시간이 이 순서 문제를 가릴 수 있다. AWS CloudFormation IAM 역할 문서는 역할과 별도로 연결되는 정책에 대해 소비 리소스의 명시적 의존성을 요구한다.

**Fix:** 서비스 생성 후 다음 의존성을 추가한다. 수집 일정에는 이미 같은 방식의 실행 역할 의존성이 있다.

```ts
webService.node.addDependency(webExecutionRole);
```

합성된 웹 서비스의 `DependsOn`에 실행 역할의 `DefaultPolicy` 리소스가 포함되는지 검사한다.

## 확인된 구성

| 항목 | 확인 결과와 근거 |
| --- | --- |
| 기존 네트워크 재사용 | 검증된 VPC, 두 퍼블릭 서브넷, 두 프라이빗 서브넷 및 라우트 테이블을 명시적으로 import한다. 템플릿에 새 VPC, NAT, 서브넷, 라우트, 엔드포인트가 없다. `infra/lib/stack.ts:35` |
| CloudFront와 ALB 경계 | ALB 인바운드는 지정 Prefix List의 TCP 80만 허용한다. listener 기본 응답은 403이고, 전용 헤더가 일치하는 규칙만 웹 target group으로 전달한다. 두 리소스는 같은 Secrets Manager 동적 참조를 사용한다. `infra/lib/stack.ts:63`, `infra/lib/stack.ts:113` |
| 비밀 노출 범위 | 비밀 값은 태스크 환경변수와 스택 출력에 포함되지 않는다. 웹과 수집 역할에 비밀 읽기 권한이 없다. `infra/lib/stack.ts:82`, `tests/infra.test.ts:97` |
| 태스크 통신과 런타임 | ALB egress는 웹 SG 8080으로 제한된다. 웹은 ALB만 인바운드 허용하며 수집기는 인바운드가 없다. 두 태스크는 프라이빗 서브넷, 공인 IP 비활성, ARM64, Node 사용자, 읽기 전용 루트 파일시스템을 사용한다. CPU와 메모리, 웹 확장 범위 1~2, rollback, `/healthz`가 지시와 일치한다. `infra/lib/stack.ts:64`, `infra/lib/stack.ts:240` |
| S3 및 역할 분리 | 버킷은 비공개, SSE-S3, 버전 관리, TLS 강제, 삭제 시 보존과 수명 주기를 사용한다. 웹은 `published/*` 읽기만 가능하다. 수집기는 스냅샷 읽기와 조건부 쓰기, `raw/*` 쓰기 및 빈 버킷 초기화에 필요한 버킷 조회 권한을 가진다. 실제 S3 호출의 키와 권한이 일치한다. `infra/lib/stack.ts:69`, `infra/lib/stack.ts:209`, `src/collector/store.ts:76` |
| Bedrock 글로벌 추론 | 정확한 글로벌 Haiku 추론 프로필과 foundation model을 지정하며 리전만 wildcard다. foundation model 호출은 같은 추론 프로필 조건으로 제한된다. 실제 코드는 `ConverseCommand`를 사용하고 이 API에 필요한 `bedrock:InvokeModel` 권한이 있다. `infra/lib/stack.ts:227`, `src/collector/explanation.ts:126` |
| Scheduler | 09:00 Asia/Seoul, flexible window OFF, Fargate 1.4.0, 태스크 1개, 프라이빗 네트워크를 사용한다. 신뢰 정책은 계정과 schedule group ARN을 제한한다. `RunTask`는 worker revision과 cluster, `PassRole`은 worker의 task/execution 역할 두 개와 ECS tasks 서비스로 제한한다. 관련 역할 정책의 생성 의존성도 있다. `infra/lib/stack.ts:316` |
| 재시도와 DLQ | 시작 요청에 2회 재시도, 최대 1시간 수명, SSE-SQS와 TLS 강제 및 14일 보존 DLQ가 적용된다. 실행이 시작된 후의 실패는 프로세스 지표와 로그가 담당한다. `infra/lib/stack.ts:310`, `infra/lib/stack.ts:360`, `src/collector/run.ts:7` |
| 배포 의존성 | CloudFront는 ALB를 참조하고 태스크 정의는 CloudFront 도메인을 참조한다. ECS 서비스가 원본 listener rule을 기다리므로 이 경로에 순환 의존성은 없다. 별도로 위 웹 실행 역할 정책 의존성을 보완해야 한다. |
| 이미지 | CDK asset은 `linux/arm64`다. 빌드는 잠금 파일로 설치하고 실행 단계에는 production 의존성과 `dist`를 넣는다. 개발 산출물과 자격 증명 디렉터리는 빌드 문맥에서 제외된다. S3 저장소를 사용하는 배포 실행 경로는 로컬 파일 쓰기를 요구하지 않는다. `Dockerfile:1`, `.dockerignore:1`, `tools/build.mjs:4` |
| 캐시와 응답 | API 캐시의 최대 TTL은 60초이며 `no-store`를 허용한다. 정적 해시 파일과 폰트는 장기 캐시한다. 오류 상태를 200으로 바꾸지 않고 앱 CSP를 덮어쓰지 않는다. `infra/lib/stack.ts:131`, `infra/lib/stack.ts:151`, `src/server/app.ts:78` |
| 관측과 출력 | 별도 로그 그룹 두 개의 보존 기간은 14일이다. EMF namespace와 dimension이 알람과 일치한다. 수집 실패, ALB/target 5xx, healthy target 부족과 DLQ 알람 및 필수 스택 출력이 있다. SNS 발송은 추가하지 않았다. `infra/lib/stack.ts:197`, `infra/lib/stack.ts:369`, `infra/lib/stack.ts:424` |

최초 스냅샷 생성 전에는 웹 역할에 `ListBucket` 권한이 없어 S3의 없는 키 조회가 403일 수 있다. 서버는 이 상황을 API 503으로 처리하며 `/healthz`는 200을 반환한다. 설계의 최초 수집을 배포 검증에 포함해야 한다. 웹 권한을 확대할 사유는 아니다.

## 근거와 검증 범위

현재 합성된 `cdk.out/CodePulse.template.json`과 asset manifest를 직접 읽고 IAM 정책, `DependsOn`, 네트워크 설정, 이미지 플랫폼, 알람 및 캐시 속성을 대조했다. 최종 애플리케이션 의존성 갱신과 Fastify 정적 파일 수정의 회귀 검증은 부모 작업의 범위다. 초기 구현 보고서의 이전 이미지나 취약점 개수를 최종 결과로 사용하지 않았다.

다음 AWS 공식 문서를 2026-10-07에 읽기 전용으로 확인했다.

- CloudWatch 누락 지표: `https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/alarms-and-missing-data.html`
- CloudWatch 평가 창: `https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/alarm-evaluation-window.html`
- CloudFormation IAM 역할과 별도 정책 의존성: `https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-resource-iam-role.html`
- Scheduler 신뢰 정책의 schedule group 범위: `https://docs.aws.amazon.com/scheduler/latest/UserGuide/cross-service-confused-deputy-prevention.html`
- Bedrock 추론 프로필 권한: `https://docs.aws.amazon.com/bedrock/latest/userguide/inference-profiles-prereq.html`
- Bedrock Converse 권한: `https://docs.aws.amazon.com/bedrock/latest/APIReference/API_runtime_Converse.html`

## 2026-10-07 후속 검토: P2 두 항목 해결

최종 판정: 초기 리뷰의 P2 두 항목이 모두 해결됐다. 이번 수정에 대한 배포 전 코드 검토에서 남은 지적 사항은 없다. 이 판정은 앞부분의 수정 권고 상태를 대체한다. 실제 AWS 배포와 서비스 동작 검증은 부모 작업에서 이어간다.

| 기존 지적 | 수정과 독립 확인 | 상태 |
| --- | --- | --- |
| 이전 성공 지표로 일일 누락을 가릴 수 있음 | `infra/lib/stack.ts:382`에서 알람 설명을 완료된 UTC 하루 기준으로 바꾸고, `infra/lib/stack.ts:393`에 wall clock 평가 창을 지정했다. 현재 합성 템플릿의 `MissingCollectionSuccessAlarm1DA0A53E`에 `EvaluationWindow: { WallClockWindow: { Timezone: "UTC" } }`가 있으며 기간 86400초, 평가 기간 1개, Sum, 임계치 1과 누락 시 breaching 설정도 유지됨을 직접 확인했다. `tests/infra.test.ts:314`가 이 설정 전체를 검증한다. | 해결 |
| 웹 실행 역할 정책의 적용 순서가 보장되지 않음 | `infra/lib/stack.ts:279`에 실행 역할 의존성이 추가됐다. 현재 합성 템플릿의 `WebService7F8A1763.DependsOn`에 `WebExecutionRoleE06F8825`와 `WebExecutionRoleDefaultPolicyFC8EC453`이 모두 포함됨을 직접 확인했다. `tests/infra.test.ts:149`는 실행 역할에 연결된 실제 정책 리소스를 찾아 순서와 무관하게 의존성을 검증한다. 웹 서비스에서 이어지는 20개 리소스의 의존성에 순환이 없음도 확인했다. | 해결 |

누락 알람은 완료된 UTC 날짜를 평가하므로, 해당 날짜의 성공 기록 누락은 다음 UTC 자정인 한국 시각 09:00 이후 평가에 반영된다. 현재 수집이 끝나는 즉시 확인하는 알람과 구분해 설명한 `docs/infra-report.md:95`의 운영 기록도 수정 의도와 일치한다.

후속 검토에서는 변경 코드, 회귀 테스트, 추가 구현 보고서와 현재 합성 템플릿을 읽고 두 설정에 대한 정적 검증만 수행했다. 인프라 테스트 17개 통과, synth 통과, cdk-nag 미해결 항목 0개는 구현자의 추가 검증 기록이다. 이 리뷰에서 테스트나 synth를 다시 실행하지 않았으며, Docker 빌드와 AWS 배포도 수행하지 않았다. 수정한 파일은 이 검토 보고서뿐이다.

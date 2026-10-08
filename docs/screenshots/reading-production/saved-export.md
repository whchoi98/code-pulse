# Code Pulse 저장한 글

총 1개

한국어 설명은 공식 발표를 바탕으로 작성한 AI 해설입니다. 적용 조건은 연결된 공식 원문을 확인하세요.

## [Claude Code 2.1.293, Haiku 5.5 지원 추가와 세션 안정성 수정](<https://code-pulse.whchoi.net/?entry=claude-code-f0dfd4cdfef10f9572e0>)

- 제품: Claude Code (CLI)
- 공식 발표일: 2026-10-07
- 버전: 2.1.293
- 구분: 새 기능

Claude Code 2.1.293에 Haiku 5.5 지원이 추가됐으며, 원문은 이를 Anthropic API의 기본 Haiku 모델로 안내합니다. subagentStatusLine에 agentType이 추가되었고 mods의 도구 등록에는 isDeferred 옵션이 들어갔습니다. 세션 복구, 원격 제어, 키 입력 처리 등의 문제도 함께 고쳤습니다.

### 왜 중요한가요?

Haiku 5.5 사용 여부는 작업에 설정된 모델 이름을 확인해야 합니다. 이 모델은 1M 컨텍스트를 지원하며, 100K 토큰을 넘는 프롬프트에는 더 높은 단가가 적용됩니다. 서브에이전트 상태 스크립트는 agentType으로 커스텀 타입을 구분할 수 있습니다. HTTP MCP 연결의 메모리 누수와 컨텍스트 압축 이후 작업 완료 판단 오류도 고쳤습니다.

### 달라진 점

- **Anthropic API의 기본 Haiku 모델이 Haiku 5.5로 변경**: claude-haiku-5-5가 추가되어 Anthropic API의 기본 Haiku 모델이 되었습니다. 1M 컨텍스트를 지원하며, 입력과 출력 단가는 100만 토큰당 $0.10과 $0.50이고, 100K 토큰을 넘는 프롬프트는 $0.50과 $2.50이 적용됩니다.
- **서브에이전트 상태 스크립트에서 커스텀 타입 구분 가능**: subagentStatusLine 페이로드에 agentType이 추가되어, 스크립트가 커스텀 서브에이전트 타입을 구분할 수 있습니다.
- **HTTP MCP 연결의 메모리 누수 수정**: HTTP MCP 연결이 닫힐 때까지 보낸 요청을 모두 붙잡고 있던 메모리 누수가 고쳐졌습니다.

### 적용 전 확인

- Haiku 5.5 사용을 검토한다면 모델 식별자 claude-haiku-5-5와 100K 토큰 초과 프롬프트의 요금 조건을 확인하세요.
- 서브에이전트 상태 스크립트를 쓴다면 subagentStatusLine 페이로드의 agentType 값을 읽도록 수정할 수 있습니다.
- 컨텍스트 압축 이후 Claude가 끝난 작업을 되돌리거나 다시 수행하던 문제가 있었다면 이번 버전에서 같은 현상이 있는지 확인하세요.

[공식 원문](<https://github.com/anthropics/claude-code/releases/tag/v2.1.293>)

---


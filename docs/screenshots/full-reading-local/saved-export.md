# Code Pulse 저장한 글

총 1개

한국어 설명은 공식 발표를 바탕으로 작성한 AI 해설입니다. 적용 조건은 연결된 공식 원문을 확인하세요.

## [Claude Code v2.1.294, 지시문 형태 prompt, agent 훅의 차단 판정 수정](<http://127.0.0.1:4198/?entry=claude-code-7742de6497a4907625ea>)

- 제품: Claude Code (CLI)
- 공식 발표일: 2026-10-08
- 버전: 2.1.294
- 구분: 오류 수정

### 짧은 요약

지시문 형태로 작성된 \`prompt\`와 \`agent\` 훅이 차단해야 할 명령을 통과시키던 문제를 고쳤습니다. 또한 Stop과 SubagentStop에 걸린 \`prompt\` 훅의 판정 방식을 개선해 Claude가 작업을 너무 일찍 멈추는 경우를 줄였습니다.

### 왜 중요한가요?

'Block commands that...'처럼 차단 규칙을 자연어로 적은 훅이 실제로 막아야 할 명령을 놓치지 않게 됩니다. 빌드가 깨졌을 때 계속 진행하라고 적어 둔 Stop 훅도 의도한 대로 판정되어, 에이전트가 중간에 멈추는 일이 줄어들 수 있습니다.

### 주요 변경 요약

- **지시문 형태 훅의 차단 실패 수정**: 'Block commands that...' 같은 지시문으로 작성된 \`prompt\`와 \`agent\` 훅이 차단해야 할 동작을 허용하던 문제가 고쳐졌습니다. 자연어로 규칙을 적어 둔 훅을 쓰는 팀이라면 이 수정의 영향을 받습니다.
- **Stop, SubagentStop 프롬프트 훅 판정 개선**: 'Carry on if the build is broken'처럼 조건을 지시문으로 적은 Stop과 SubagentStop의 \`prompt\` 훅 판정이 개선되었습니다. 원문에는 개선의 정도가 나와 있지 않으므로, 판정이 나아져 Claude가 필요한 작업을 끝내기 전에 멈출 가능성이 낮아진다고 이해하면 됩니다.

### 적용 전 확인

- 지시문 형태로 작성한 \`prompt\`나 \`agent\` 훅이 있다면 차단해야 할 명령이 실제로 막히는지 테스트해 보세요.
- Stop 또는 SubagentStop에 걸어 둔 \`prompt\` 훅이 있다면 해당 조건에서 작업을 이어 가는지 확인하세요.

### 전체 변경 사항

총 2개

1. 지시문 형태로 작성된 \`prompt\` 및 \`agent\` 훅\(예: "Block commands that..."\)이 차단해야 할 동작을 허용하던 문제를 수정했습니다. 이제 이런 훅은 의도한 대로 해당 명령을 차단합니다.
2. Stop 및 SubagentStop 이벤트에서 지시문 형태로 작성된 \`prompt\` 훅\(예: "Carry on if the build is broken"\)의 판단 방식을 개선했습니다. 이에 따라 Claude가 작업을 너무 일찍 멈추는 경우가 줄어듭니다.

[공식 원문](<https://github.com/anthropics/claude-code/releases/tag/v2.1.294>)

[Claude Code 공식 변경 기록](<https://code.claude.com/docs/en/changelog>)

---

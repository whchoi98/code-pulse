import type { FullChanges } from '../../src/shared/types';

// Invented changes exercise complete coverage without copying an official body.
export function fullChangesFixture(overrides: Partial<FullChanges> = {}): FullChanges {
  return {
    status: 'ready',
    sourceHash: 'PRIVATE_FULL_SOURCE_HASH',
    model: 'PRIVATE_FULL_MODEL',
    formatVersion: 'test-full-changes-v1',
    updatedAt: '2026-10-07T01:00:00Z',
    sourceCount: 56,
    items: Array.from({ length: 56 }, (_, index) => ({
      id: `change-${index + 1}`,
      text: index === 0 ? '첫 번째 변경: 작업 공간 설정을 유지합니다.'
        : index === 55 ? '마지막 변경: 잔여세션정리 오류를 고쳤습니다.'
          : `변경 ${index + 1}: 작업 ${index + 1}의 오류 메시지를 이해하기 쉽게 바꿨습니다.`,
    })),
    ...overrides,
  };
}

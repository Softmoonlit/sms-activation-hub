export const MIN_CANDIDATE_POSITION_COUNT = 3;
export const MAX_CANDIDATE_POSITION_COUNT = 10;

export const CANDIDATE_POSITION_COUNTS = Object.freeze(
  Array.from(
    { length: MAX_CANDIDATE_POSITION_COUNT - MIN_CANDIDATE_POSITION_COUNT + 1 },
    (_, index) => index + MIN_CANDIDATE_POSITION_COUNT,
  ),
);

export function parseCandidatePositionCount(value: string | undefined): number | undefined {
  if (!value || !/^\d+$/.test(value)) return undefined;
  const count = Number(value);
  return Number.isSafeInteger(count)
    && count >= MIN_CANDIDATE_POSITION_COUNT
    && count <= MAX_CANDIDATE_POSITION_COUNT
    ? count
    : undefined;
}

export function toRaterDataset(dataset) {
  return {
    ...dataset,
    questions: dataset.questions.map(({ id, question }) => ({ id, question })),
  };
}

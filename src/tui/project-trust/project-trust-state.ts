/** The pending trust question shown at startup; null when nothing is asked. */
export interface ProjectTrustPrompt {
  workingDir: string;
  question: string;
  questionId: string;
}

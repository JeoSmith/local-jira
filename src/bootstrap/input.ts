export const PROJECT_KEY_PATTERN = /^[A-Z][A-Z0-9]{1,9}$/;
export const PROJECT_NAME_MAX_LENGTH = 100;

export type InputErrorCode =
  | "E_INVALID_PROJECT_KEY"
  | "E_INVALID_PROJECT_NAME"
  | "E_INVALID_TIMEZONE";

export class BootstrapInputError extends Error {
  readonly code: InputErrorCode;
  readonly field: string;

  constructor(code: InputErrorCode, field: string, message: string) {
    super(message);
    this.name = "BootstrapInputError";
    this.code = code;
    this.field = field;
  }
}

export interface ProjectInput {
  projectKey: string;
  projectName: string;
  timezone: string;
}

export function validateProjectKey(value: string): string {
  if (!PROJECT_KEY_PATTERN.test(value)) {
    throw new BootstrapInputError(
      "E_INVALID_PROJECT_KEY",
      "--project-key",
      `Project key "${value}" must match ${PROJECT_KEY_PATTERN.source} (uppercase, 2-10 characters).`,
    );
  }
  return value;
}

export function validateProjectName(value: string): string {
  const trimmed = value.trim();
  // Count Unicode scalars, not UTF-16 code units, so a name of emoji or
  // Hangul is measured the way a person would read it.
  const scalars = [...trimmed];

  if (scalars.length === 0 || scalars.length > PROJECT_NAME_MAX_LENGTH) {
    throw new BootstrapInputError(
      "E_INVALID_PROJECT_NAME",
      "--project-name",
      `Project name must be 1-${PROJECT_NAME_MAX_LENGTH} characters after trimming (got ${scalars.length}).`,
    );
  }
  if (scalars.some(isControlCharacter)) {
    throw new BootstrapInputError(
      "E_INVALID_PROJECT_NAME",
      "--project-name",
      "Project name must not contain control characters.",
    );
  }
  return trimmed;
}

export function validateTimezone(value: string): string {
  if (value.trim() !== value || value.length === 0) {
    throw new BootstrapInputError(
      "E_INVALID_TIMEZONE",
      "--timezone",
      `Timezone "${value}" must not be empty or padded with whitespace.`,
    );
  }
  try {
    // The runtime tzdb is the authority; there is no list to keep in sync.
    new Intl.DateTimeFormat("en-US", { timeZone: value });
  } catch {
    throw new BootstrapInputError(
      "E_INVALID_TIMEZONE",
      "--timezone",
      `Timezone "${value}" is not an IANA timezone known to this runtime.`,
    );
  }
  return value;
}

export function validateProjectInput(input: ProjectInput): ProjectInput {
  return {
    projectKey: validateProjectKey(input.projectKey),
    projectName: validateProjectName(input.projectName),
    timezone: validateTimezone(input.timezone),
  };
}

function isControlCharacter(scalar: string): boolean {
  const codePoint = scalar.codePointAt(0) ?? 0;
  return (
    (codePoint >= 0x00 && codePoint <= 0x1f) ||
    (codePoint >= 0x7f && codePoint <= 0x9f)
  );
}

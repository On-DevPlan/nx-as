export const CODES = {
  INVALID_INPUT: 'INVALID_INPUT',
  UNAUTHORIZED: 'UNAUTHORIZED',
  NOT_FOUND: 'NOT_FOUND',
  CONFLICT: 'CONFLICT',
  BLOCKED: 'BLOCKED',
  EXTERNAL: 'EXTERNAL',
  INTERNAL: 'INTERNAL',
};

export class AppError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

export function badInput(message, details) {
  return new AppError(CODES.INVALID_INPUT, message, details);
}
export function unauthorized(message) {
  return new AppError(CODES.UNAUTHORIZED, message || '缺少或错误的密钥（Authorization: Bearer <token>）');
}
export function notFound(message, details) {
  return new AppError(CODES.NOT_FOUND, message, details);
}
export function conflict(message, details) {
  return new AppError(CODES.CONFLICT, message, details);
}
export function blocked(message, details) {
  return new AppError(CODES.BLOCKED, message, details);
}
export function external(message, details) {
  return new AppError(CODES.EXTERNAL, message, details);
}

const HTTP_STATUS = {
  [CODES.INVALID_INPUT]: 400,
  [CODES.UNAUTHORIZED]: 401,
  [CODES.NOT_FOUND]: 404,
  [CODES.CONFLICT]: 409,
  [CODES.BLOCKED]: 409,
  [CODES.EXTERNAL]: 502,
  [CODES.INTERNAL]: 500,
};

export function httpStatusOf(code) {
  return HTTP_STATUS[code] || 500;
}

export function exitCodeOf() {
  return 1;
}

// 把任意异常归一成 AppError（兜底 INTERNAL）
export function asAppError(err) {
  if (err instanceof AppError) return err;
  const e = new AppError(CODES.INTERNAL, (err && err.message) || String(err));
  return e;
}

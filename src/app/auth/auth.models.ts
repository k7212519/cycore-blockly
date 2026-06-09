export interface ApiResponse<T = unknown> {
  code: number;
  message: string;
  data: T;
}

export interface EdaUser {
  userId: number;
  username: string;
  realName?: string;
  userType?: string;
  expireTime?: number;
}

export interface LoginResponse extends EdaUser {
  token: string;
}

export interface LoginRequest {
  username: string;
  password: string;
  rememberMe: boolean;
}

export interface RegisterRequest {
  username: string;
  password: string;
  confirmPassword: string;
  activationCode: string;
  email?: string;
  phone?: string;
  realName?: string;
}

export interface RecoverRequest {
  username: string;
  password: string;
  confirmPassword: string;
  activationCode: string;
}

export interface RecoveryCodeResult {
  codeValid: boolean;
  hasUser?: boolean;
  maskedUsername?: string;
}

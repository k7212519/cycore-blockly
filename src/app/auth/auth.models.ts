export interface ApiResponse<T = unknown> {
  code: number;
  message: string;
  data: T;
  errorCode?: string;
}

export type ProductAccessStatus = 'ACTIVE' | 'NOT_ACTIVATED' | 'REVOKED';

export interface ProductAccess {
  status: ProductAccessStatus;
  activatedTime?: string;
}

export interface EdaUser {
  userId: number;
  username: string;
  realName?: string;
  userType?: string;
  expireTime?: number;
  productCode?: 'L2';
  productAccess?: ProductAccess;
}

export interface LoginResponse extends EdaUser {
  token: string;
}

export interface LoginRequest {
  username: string;
  password: string;
  rememberMe: boolean;
  productCode?: 'L2';
}

export interface RegisterRequest {
  username: string;
  password: string;
  confirmPassword: string;
  activationCode: string;
  email?: string;
  phone?: string;
  realName?: string;
  productCode?: 'L2';
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

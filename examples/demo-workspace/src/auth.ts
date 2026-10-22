export interface UserSession {
  userId: string;
  username: string;
  role: "admin" | "user" | "guest";
}

export class AuthService {
  private activeUsers = new Map<string, UserSession>();

  public login(userId: string, username: string, role: "admin" | "user" | "guest" = "user"): UserSession {
    const session: UserSession = { userId, username, role };
    this.activeUsers.set(userId, session);
    return session;
  }

  public getSession(userId: string): UserSession | undefined {
    return this.activeUsers.get(userId);
  }

  public logout(userId: string): boolean {
    return this.activeUsers.delete(userId);
  }
}

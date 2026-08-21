import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { admin as adminPlugin, mcp } from "better-auth/plugins";
import { db } from "@/db";
import * as schema from "@/db/schema";
import { ac, admin, editor, journalist, monteur } from "./permissions";

export const auth = betterAuth({
  database: drizzleAdapter(db, { provider: "pg", schema }),
  emailAndPassword: { enabled: true, disableSignUp: true },
  plugins: [
    adminPlugin({
      ac,
      roles: { admin, editor, journalist, monteur },
      defaultRole: "journalist",
      adminRoles: ["admin"],
    }),
    mcp({
      loginPage: "/login",
      resource: `${process.env.BETTER_AUTH_URL ?? ""}/api/mcp`,
      oidcConfig: {
        loginPage: "/login",
        requirePKCE: true,
        allowDynamicClientRegistration: true,
        consentPage: "/oauth/authorize",
      },
    }),
  ],
  session: { expiresIn: 60 * 60 * 24 * 7 },
});

export type Role = "admin" | "editor" | "journalist" | "monteur";

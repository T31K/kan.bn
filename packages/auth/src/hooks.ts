import { ChatOrPushProviderEnum } from "@novu/api/models/components";
import { createAuthMiddleware } from "better-auth/api";
import { env } from "next-runtime-env";

import type { dbClient } from "@kan/db/client";
import * as memberRepo from "@kan/db/repository/member.repo";
import * as userRepo from "@kan/db/repository/user.repo";
import { notificationClient } from "@kan/email";
import { createLogger } from "@kan/logger";
import {
  createEmailUnsubscribeLink,
  uploadToCloudflareImages,
} from "@kan/shared";

const log = createLogger("auth");

import { downloadImage } from "./utils";

type BetterAuthUser = {
  id: string;
  createdAt: Date;
  updatedAt: Date;
  email: string;
  emailVerified: boolean;
  name: string;
  image?: string | null | undefined;
  stripeCustomerId?: string | null | undefined;
} & Record<string, unknown>;

export function createDatabaseHooks(db: dbClient) {
  return {
    user: {
      create: {
        async before(user: BetterAuthUser, _context: unknown) {
          if (env("NEXT_PUBLIC_DISABLE_SIGN_UP")?.toLowerCase() === "true") {
            const pendingInvitation = await memberRepo.getByEmailAndStatus(
              db,
              user.email,
              "invited",
            );

            if (!pendingInvitation) {
              return Promise.resolve(false);
            }

            // Fall through to any additional checks below
          }
          // Enforce allowed domains (OIDC/social) if configured
          const allowed = process.env.BETTER_AUTH_ALLOWED_DOMAINS?.split(",")
            .map((d) => d.trim().toLowerCase())
            .filter(Boolean);
          if (allowed && allowed.length > 0) {
            const domain = user.email.split("@")[1]?.toLowerCase();
            if (!domain || !allowed.includes(domain)) {
              return Promise.resolve(false);
            }
          }
          return Promise.resolve(true);
        },
        async after(user: BetterAuthUser, _context: unknown) {
          let avatarKey = user.image;
          // For OAuth signups the provider hands us a remote avatar URL.
          // Mirror it into Cloudflare Images so the URL we serve is stable
          // and on our own infra. Skip if it's already on imagedelivery.net
          // (i.e. already mirrored on a previous run).
          if (
            user.image &&
            !user.image.includes("imagedelivery.net") &&
            process.env.CLOUDFLARE_ACCOUNT_ID &&
            process.env.CLOUDFLARE_API_KEY
          ) {
            try {
              const allowedFileExtensions = ["jpg", "jpeg", "png", "webp"];
              const fileExtension =
                user.image.split(".").pop()?.split("?")[0] ?? "jpg";
              const safeExt = !allowedFileExtensions.includes(fileExtension)
                ? "jpg"
                : fileExtension;
              const filename = `${user.id}-avatar.${safeExt}`;
              const contentType = `image/${safeExt === "jpg" ? "jpeg" : safeExt}`;

              const imageBuffer = await downloadImage(user.image);

              const cfUrl = await uploadToCloudflareImages(
                imageBuffer,
                filename,
                contentType,
              );

              avatarKey = cfUrl;

              await userRepo.update(db, user.id, {
                image: cfUrl,
              });
            } catch (error) {
              console.error(error);
            }
          }

          if (notificationClient) {
            try {
              const [firstName, ...rest] = (user.name || "")
                .split(" ")
                .filter(Boolean);
              const lastName = rest.length ? rest.join(" ") : undefined;
              // With CF Images, avatarKey is already a public URL. Legacy
              // S3 keys are still composed with the storage URL + bucket.
              const avatarUrl = avatarKey
                ? avatarKey.startsWith("http")
                  ? avatarKey
                  : `${env("NEXT_PUBLIC_STORAGE_URL")}/${env("NEXT_PUBLIC_AVATAR_BUCKET_NAME")}/${avatarKey}`
                : undefined;

              const unsubscribeUrl = await createEmailUnsubscribeLink(user.id);

              log.info({ workflowId: "user-signup", userId: user.id, email: user.email }, "Triggering Novu workflow");
              await notificationClient.trigger({
                to: {
                  subscriberId: user.id,
                  firstName: firstName,
                  lastName: lastName,
                  email: user.email,
                  avatar: avatarUrl,
                  data: {
                    emailVerified: user.emailVerified,
                    stripeCustomerId: user.stripeCustomerId,
                    createdAt: user.createdAt,
                    updatedAt: user.updatedAt,
                  },
                },
                payload: {
                  emailUnsubscribeUrl: unsubscribeUrl,
                },
                workflowId: "user-signup",
              });
              log.info({ workflowId: "user-signup", userId: user.id }, "Novu workflow triggered");

              await notificationClient.subscribers.credentials.update(
                {
                  providerId: ChatOrPushProviderEnum.Discord,
                  credentials: {
                    webhookUrl: env("DISCORD_WEBHOOK_URL"),
                  },
                  integrationIdentifier: "discord",
                },
                user.id,
              );
            } catch (error) {
              log.error({ err: error }, "Error adding user to notification client");
            }
          }
        },
      },
    },
  };
}

export function createMiddlewareHooks(db: dbClient) {
  return {
    after: createAuthMiddleware(async (ctx) => {
      if (
        ctx.path === "/magic-link/verify" &&
        (ctx.query?.callbackURL as string | undefined)?.includes("type=invite")
      ) {
        const userId = ctx.context.newSession?.session.userId;
        const callbackURL = ctx.query?.callbackURL as string | undefined;
        const memberPublicId = callbackURL?.split("memberPublicId=")[1];

        if (userId && memberPublicId) {
          const member = await memberRepo.getByPublicId(db, memberPublicId);

          if (member?.id) {
            await memberRepo.acceptInvite(db, {
              memberId: member.id,
              userId,
            });
          }
        }
      }
    }),
  };
}

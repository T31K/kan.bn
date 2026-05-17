import type { NextApiRequest, NextApiResponse } from "next";

import { createNextApiContext } from "@kan/api/trpc";
import { withApiLogging } from "@kan/api/utils/apiLogging";
import { assertPermission } from "@kan/api/utils/permissions";
import { withRateLimit } from "@kan/api/utils/rateLimit";
import * as cardRepo from "@kan/db/repository/card.repo";
import * as cardActivityRepo from "@kan/db/repository/cardActivity.repo";
import * as cardAttachmentRepo from "@kan/db/repository/cardAttachment.repo";
import { generateUID, uploadToCloudflareImages } from "@kan/shared/utils";

// FIXME: Respect the environment variable: NEXT_API_BODY_SIZE_LIMIT
const MAX_SIZE_BYTES = 50 * 1024 * 1024; // 50MB

export const config = {
  api: {
    bodyParser: false,
  },
};

export default withRateLimit(
  { points: 100, duration: 60 },
  withApiLogging(async (req: NextApiRequest, res: NextApiResponse) => {
    if (req.method !== "POST") {
      return res.status(405).json({ error: "Method not allowed" });
    }

    try {
      const { user, db } = await createNextApiContext(req);

      if (!user) {
        return res.status(401).json({ error: "Unauthorized" });
      }

      const cardPublicId = req.query.cardPublicId;
      if (typeof cardPublicId !== "string" || cardPublicId.length < 12) {
        return res.status(400).json({ error: "Invalid cardPublicId" });
      }

      const contentType = req.headers["content-type"];
      const contentLengthHeader = req.headers["content-length"];
      const contentLength = contentLengthHeader
        ? Number.parseInt(contentLengthHeader, 10)
        : NaN;

      if (typeof contentType !== "string") {
        return res.status(400).json({ error: "Missing content type" });
      }

      if (!Number.isFinite(contentLength) || contentLength <= 0) {
        return res
          .status(400)
          .json({ error: "Missing or invalid content length" });
      }

      if (contentLength > MAX_SIZE_BYTES) {
        return res.status(400).json({ error: "File too large" });
      }

      const rawFilenameHeader =
        (req.headers["x-original-filename"] as string | undefined) ?? "file";
      // Client URL-encodes the header to allow unicode (headers are Latin-1 only).
      let originalFilenameHeader = rawFilenameHeader;
      try {
        originalFilenameHeader = decodeURIComponent(rawFilenameHeader);
      } catch {
        // Fall back to the raw value if it wasn't URL-encoded.
      }

      const sanitizedFilename = originalFilenameHeader
        .replace(/[^a-zA-Z0-9._-]/g, "_")
        .substring(0, 200);

      // Get card and check permissions
      const card = await cardRepo.getWorkspaceAndCardIdByCardPublicId(
        db,
        cardPublicId,
      );

      if (!card) {
        return res.status(404).json({ error: "Card not found" });
      }

      // Check if user has permission to edit the card
      try {
        await assertPermission(db, user.id, card.workspaceId, "card:edit");
      } catch {
        return res.status(403).json({ error: "Permission denied" });
      }

      console.log("[upload/attachment] incoming", {
        cardPublicId,
        contentType,
        contentLength,
        originalFilenameHeader,
        cfAccount: !!process.env.CLOUDFLARE_ACCOUNT_ID,
        cfKey: !!process.env.CLOUDFLARE_API_KEY,
      });

      // Buffer the request body, then upload to Cloudflare Images.
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      const fileBuffer = Buffer.concat(chunks);
      console.log("[upload/attachment] buffered", { bytes: fileBuffer.length });

      const cfFilename = `${card.workspaceId}-${cardPublicId}-${generateUID()}-${sanitizedFilename}`;
      let s3Key: string;
      try {
        s3Key = await uploadToCloudflareImages(
          fileBuffer,
          cfFilename,
          contentType,
        );
        console.log("[upload/attachment] CF upload OK", { s3Key });
      } catch (cfErr) {
        console.error("[upload/attachment] CF upload FAILED", cfErr);
        return res
          .status(500)
          .json({ error: `CF upload failed: ${(cfErr as Error).message}` });
      }

      const attachment = await cardAttachmentRepo.create(db, {
        cardId: card.id,
        filename: sanitizedFilename,
        originalFilename: originalFilenameHeader,
        contentType,
        size: contentLength,
        s3Key,
        createdBy: user.id,
      });
      console.log("[upload/attachment] DB row created", {
        id: attachment?.id,
      });

      if (!attachment) {
        return res.status(500).json({ error: "Failed to create attachment" });
      }

      await cardActivityRepo.create(db, {
        type: "card.updated.attachment.added",
        cardId: card.id,
        attachmentId: attachment.id,
        toTitle: originalFilenameHeader,
        createdBy: user.id,
      });

      return res.status(200).json({ attachment });
    } catch (error) {
      console.error("[upload/attachment] unhandled error", error);
      return res
        .status(500)
        .json({ error: `Internal: ${(error as Error).message}` });
    }
  }),
);

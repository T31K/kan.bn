import type { NextApiRequest, NextApiResponse } from "next";

import { createNextApiContext } from "@kan/api/trpc";
import { withApiLogging } from "@kan/api/utils/apiLogging";
import { withRateLimit } from "@kan/api/utils/rateLimit";
import * as userRepo from "@kan/db/repository/user.repo";
import { uploadToCloudflareImages } from "@kan/shared/utils";

const MAX_SIZE_BYTES = parseInt(
  process.env.S3_AVATAR_UPLOAD_LIMIT || "2097152",
  10,
); // Default 2MB
const allowedContentTypes = ["image/jpeg", "image/png", "image/webp"];

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

      const contentType = req.headers["content-type"];
      const contentLengthHeader = req.headers["content-length"];
      const contentLength = contentLengthHeader
        ? Number.parseInt(contentLengthHeader, 10)
        : NaN;

      if (typeof contentType !== "string") {
        return res.status(400).json({ error: "Missing content type" });
      }

      if (!allowedContentTypes.includes(contentType)) {
        return res.status(400).json({ error: "Invalid content type" });
      }

      if (!Number.isFinite(contentLength) || contentLength <= 0) {
        return res
          .status(400)
          .json({ error: "Missing or invalid content length" });
      }

      if (contentLength > MAX_SIZE_BYTES) {
        return res.status(400).json({ error: "File too large" });
      }

      const originalFilenameHeader =
        (req.headers["x-original-filename"] as string | undefined) ?? "file";

      const sanitizedFilename = originalFilenameHeader
        .replace(/[^a-zA-Z0-9._-]/g, "_")
        .substring(0, 200);

      // Buffer the request body, then upload to Cloudflare Images.
      // We store the public delivery URL directly in `user.image`.
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      const fileBuffer = Buffer.concat(chunks);

      const cfFilename = `${user.id}-${sanitizedFilename}`;
      const s3Key = await uploadToCloudflareImages(
        fileBuffer,
        cfFilename,
        contentType,
      );

      const updatedUser = await userRepo.update(db, user.id, {
        image: s3Key,
      });

      return res.status(200).json({
        key: s3Key,
        filename: sanitizedFilename,
        contentType,
        size: contentLength,
        user: updatedUser,
      });
    } catch (error) {
      return res.status(500).json({ error: "Internal server error" });
    }
  }),
);

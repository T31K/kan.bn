import { t } from "@lingui/core/macro";
import { env } from "next-runtime-env";
import { useCallback, useState } from "react";
import { useDropzone } from "react-dropzone";
import { HiOutlinePaperClip } from "react-icons/hi";
import { HiCheckBadge } from "react-icons/hi2";
import { twMerge } from "tailwind-merge";

import Button from "~/components/Button";
import { useModal } from "~/providers/modal";
import { usePopup } from "~/providers/popup";
import { api } from "~/utils/api";
import { invalidateCard } from "~/utils/cardInvalidation";

export function AttachmentUpload({ cardPublicId }: { cardPublicId: string }) {
  const { openModal } = useModal();
  const { showPopup } = usePopup();
  const utils = api.useUtils();
  const [uploading, setUploading] = useState(false);

  const uploadFile = useCallback(
    async (file: File) => {
      console.log("[AttachmentUpload] uploadFile", {
        name: file.name,
        type: file.type,
        size: file.size,
        cardPublicId,
      });
      setUploading(true);

      try {
        const baseUrl = env("NEXT_PUBLIC_BASE_URL") ?? "";
        const url = `${baseUrl}/api/upload/attachment?cardPublicId=${encodeURIComponent(cardPublicId)}`;

        const response = await fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": file.type,
            // Headers must be ISO-8859-1; encode to preserve unicode filenames.
            "x-original-filename": encodeURIComponent(file.name),
          },
          body: file,
        });
        console.log("[AttachmentUpload] response", response.status);

        if (!response.ok) {
          const body = await response.text().catch(() => "<unreadable>");
          throw new Error(`Upload failed: ${response.status} ${body}`);
        }

        await invalidateCard(utils, cardPublicId);
        showPopup({
          header: t`Attachment uploaded`,
          message: t`Your file has been uploaded successfully.`,
          icon: "success",
        });
      } catch (e) {
        console.error("[AttachmentUpload] upload FAILED", e);
        showPopup({
          header: t`Upload failed`,
          message: t`Failed to upload attachment. Please try again.`,
          icon: "error",
        });
      } finally {
        setUploading(false);
      }
    },
    [cardPublicId, showPopup, utils],
  );

  const onDrop = useCallback(
    async (acceptedFiles: File[]) => {
      console.log("[AttachmentUpload] onDrop", { count: acceptedFiles.length });
      const file = acceptedFiles[0];
      if (!file) return;
      await uploadFile(file);
    },
    [uploadFile],
  );

  const { getRootProps, getInputProps, isDragActive, open } = useDropzone({
    onDrop,
    multiple: false,
    disabled: uploading,
    noClick: true,
    noKeyboard: true,
  });

  return (
    <div className="mb-6">
      <div
        {...getRootProps()}
        className={twMerge(
          "rounded-lg border-2 border-dashed transition-colors",
          isDragActive
            ? "border-light-300 bg-light-100 dark:border-dark-300 dark:bg-dark-100"
            : "border-transparent",
        )}
      >
        <input {...getInputProps()} />
        <div className="flex items-center justify-between p-2">
          <Button
            type="button"
            variant="ghost"
            iconLeft={
              <HiCheckBadge className="h-4 w-4 text-light-950 dark:text-dark-950" />
            }
            iconOnly
            size="sm"
            onClick={() => openModal("ADD_CHECKLIST")}
          />
          <Button
            type="button"
            variant="ghost"
            iconLeft={
              <HiOutlinePaperClip className="h-4 w-4 text-light-950 dark:text-dark-950" />
            }
            isLoading={uploading}
            disabled={uploading}
            iconOnly
            size="sm"
            onClick={open}
          />
        </div>
      </div>
    </div>
  );
}

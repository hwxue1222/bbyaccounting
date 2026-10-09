import type { ReactNode } from "react";

import Modal from "@/components/ui/Modal";
import Button from "@/components/ui/Button";

export default function Confirm({
  open,
  title,
  description,
  confirmText,
  cancelText,
  danger,
  onConfirm,
  onClose,
}: {
  open: boolean;
  title: ReactNode;
  description?: ReactNode;
  confirmText?: ReactNode;
  cancelText?: ReactNode;
  danger?: boolean;
  onConfirm: () => void | Promise<void>;
  onClose: () => void;
}) {
  return (
    <Modal
      open={open}
      title={title}
      onClose={onClose}
      widthClassName="max-w-lg"
    >
      {description ? <div className="text-sm text-zinc-600">{description}</div> : null}
      <div className="mt-4 flex items-center justify-end gap-2">
        <Button onClick={onClose}>{cancelText || "Cancel"}</Button>
        <Button variant={danger ? "danger" : "primary"} onClick={() => void onConfirm()}>
          {confirmText || "Confirm"}
        </Button>
      </div>
    </Modal>
  );
}


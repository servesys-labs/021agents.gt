import type { Meta, StoryObj } from "@storybook/react-vite";
import { Modal } from "./Modal";
import { useState } from "react";

const meta = {
  title: "Common/Modal",
  component: Modal,
} satisfies Meta<typeof Modal>;

export default meta;

export const Default: StoryObj = {
  render: () => {
    const [open, setOpen] = useState(true);
    return (
      <>
        <button className="btn btn-primary" onClick={() => setOpen(true)}>Open Modal</button>
        <Modal open={open} onClose={() => setOpen(false)} title="Example Modal" maxWidth="md">
          <p className="text-sm text-text-secondary">Modal body content goes here.</p>
        </Modal>
      </>
    );
  },
};

export const WithFooter: StoryObj = {
  render: () => {
    const [open, setOpen] = useState(true);
    return (
      <>
        <button className="btn btn-primary" onClick={() => setOpen(true)}>Open Modal</button>
        <Modal
          open={open}
          onClose={() => setOpen(false)}
          title="Create Something"
          maxWidth="lg"
          footer={
            <>
              <button className="btn btn-secondary" onClick={() => setOpen(false)}>Cancel</button>
              <button className="btn btn-primary">Save</button>
            </>
          }
        >
          <div className="space-y-4">
            <div>
              <label className="text-label text-text-muted mb-1 block">Name</label>
              <input type="text" placeholder="Enter name..." />
            </div>
            <div>
              <label className="text-label text-text-muted mb-1 block">Description</label>
              <textarea placeholder="Enter description..." rows={3} />
            </div>
          </div>
        </Modal>
      </>
    );
  },
};

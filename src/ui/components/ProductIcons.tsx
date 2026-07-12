import type { IconType } from "@astryxdesign/core";

const svgProps = {
  xmlns: "http://www.w3.org/2000/svg",
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.75,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  "aria-hidden": true as const,
};

export const RefreshIcon: IconType = (props) => (
  <svg {...svgProps} {...props}>
    <title>Refresh</title>
    <path d="M20 11a8 8 0 0 0-14.9-4L3 10" />
    <path d="M3 4v6h6" />
    <path d="M4 13a8 8 0 0 0 14.9 4L21 14" />
    <path d="M21 20v-6h-6" />
  </svg>
);

export const UploadIcon: IconType = (props) => (
  <svg {...svgProps} {...props}>
    <title>Upload</title>
    <path d="M12 3v12" />
    <path d="m7 8 5-5 5 5" />
    <path d="M4 14v6h16v-6" />
  </svg>
);

export const PlusIcon: IconType = (props) => (
  <svg {...svgProps} {...props}>
    <title>Add</title>
    <path d="M12 5v14M5 12h14" />
  </svg>
);

export const EditIcon: IconType = (props) => (
  <svg {...svgProps} {...props}>
    <title>Edit</title>
    <path d="m4 16 10-10 4 4L8 20H4z" />
    <path d="m13 7 4 4" />
  </svg>
);

export const TrashIcon: IconType = (props) => (
  <svg {...svgProps} {...props}>
    <title>Delete</title>
    <path d="M4 7h16M10 11v6M14 11v6" />
    <path d="M9 7V4h6v3M6 7l1 14h10l1-14" />
  </svg>
);

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

export const DownloadIcon: IconType = (props) => (
  <svg {...svgProps} {...props}>
    <title>Download</title>
    <path d="M12 3v12" />
    <path d="m7 10 5 5 5-5" />
    <path d="M4 14v6h16v-6" />
  </svg>
);

export const CashIcon: IconType = (props) => (
  // biome-ignore lint/a11y/noSvgWithoutTitle: The parent button provides the localized label.
  <svg {...svgProps} {...props}>
    <rect x="3" y="5" width="18" height="14" rx="2" />
    <circle cx="12" cy="12" r="3" />
    <path d="M7 8h.01M17 16h.01" />
  </svg>
);

export const WarningIcon: IconType = (props) => (
  <svg {...svgProps} {...props}>
    <title>Warning</title>
    <path d="m12 4 9 16H3L12 4Z" />
    <path d="M12 9v5M12 17h.01" />
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

export const PortfolioIcon: IconType = (props) => (
  // biome-ignore lint/a11y/noSvgWithoutTitle: The parent link provides the localized label.
  <svg {...svgProps} {...props}>
    <path d="M4 5v14h16" />
    <path d="m7 15 4-4 3 2 5-6" />
  </svg>
);

export const EventsIcon: IconType = (props) => (
  // biome-ignore lint/a11y/noSvgWithoutTitle: The parent link provides the localized label.
  <svg {...svgProps} {...props}>
    <path d="M4 8h14" />
    <path d="m15 5 3 3-3 3" />
    <path d="M20 16H6" />
    <path d="m9 13-3 3 3 3" />
  </svg>
);

export const CalendarIcon: IconType = (props) => (
  // biome-ignore lint/a11y/noSvgWithoutTitle: The parent link provides the localized label.
  <svg {...svgProps} {...props}>
    <rect x="3.5" y="5.5" width="17" height="15" rx="2" />
    <path d="M8 3.5v4M16 3.5v4M3.5 10h17" />
    <path d="M8 14h.01M12 14h.01M16 14h.01M8 17h.01M12 17h.01" />
  </svg>
);

export const StatusIcon: IconType = (props) => (
  // biome-ignore lint/a11y/noSvgWithoutTitle: The parent link provides the localized label.
  <svg {...svgProps} {...props}>
    <path d="M4 17h3l2-5 3 8 3-13 2 7h3" />
  </svg>
);

export const AccountsIcon: IconType = (props) => (
  // biome-ignore lint/a11y/noSvgWithoutTitle: The parent link provides the localized label.
  <svg {...svgProps} {...props}>
    <path d="m5 7.5 10-3.4a2 2 0 0 1 2.5 1.3l.7 2.1" />
    <path d="M6 7.5h12a2 2 0 0 1 2 2V19H6a2 2 0 0 1-2-2V7.5Z" />
    <path d="M15 11h5v4h-5a2 2 0 0 1 0-4Z" />
  </svg>
);

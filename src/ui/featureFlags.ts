const newProductUiValue = import.meta.env.VITE_NEW_PRODUCT_UI as
  | string
  | undefined;

/**
 * The product shell stays opt-in until the Plan 4 cutover. Vite only exposes
 * explicitly prefixed values, so an unset variable remains safely disabled.
 */
export const isNewProductUiEnabled = (value = newProductUiValue) =>
  value === "true";

export const logEvent = (
  event: string,
  fields: Record<string, string | number | boolean | null>,
) => {
  console.log(JSON.stringify({ event, ...fields }));
};

import { getRequestConfig } from "next-intl/server";

import messages from "../../messages/en.json";

// v1 chỉ có tiếng Anh (CODING_STANDARDS C13).
export default getRequestConfig(() =>
  Promise.resolve({ locale: "en", messages, timeZone: "Asia/Ho_Chi_Minh" }),
);

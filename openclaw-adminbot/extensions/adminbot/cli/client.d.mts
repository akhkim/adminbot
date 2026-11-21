import type { Client, ClientOptions } from "openapi-fetch";
import type { paths } from "./openapi.generated.js";
/** `adminbot-cli/<version>`, sent on every request. */
export declare const userAgent: string;
export declare function createAdminBotClient(options?: ClientOptions): Client<paths>;

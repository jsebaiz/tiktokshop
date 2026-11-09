import { createHandler } from "./server/app";
import type { Env } from "./server/env";

const handle = createHandler();

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    return handle(request, env);
  },
};

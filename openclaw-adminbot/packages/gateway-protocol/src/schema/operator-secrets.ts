// Gateway Protocol schemas for one-shot operator secret input requests.
import { Type } from "typebox";
import { NonEmptyString } from "./primitives.js";

const MAX_OPERATOR_SECRET_TIMEOUT_MS = 600_000;
const OPERATOR_SECRET_TITLE_MAX_LENGTH = 80;
const OPERATOR_SECRET_DESCRIPTION_MAX_LENGTH = 256;

/** One-shot request for an operator-entered secret value. */
export const OperatorSecretRequestParamsSchema = Type.Object(
  {
    title: Type.String({ minLength: 1, maxLength: OPERATOR_SECRET_TITLE_MAX_LENGTH }),
    description: Type.String({
      minLength: 1,
      maxLength: OPERATOR_SECRET_DESCRIPTION_MAX_LENGTH,
    }),
    variableName: NonEmptyString,
    agentId: Type.Optional(Type.String()),
    sessionKey: Type.Optional(Type.String()),
    timeoutMs: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_OPERATOR_SECRET_TIMEOUT_MS })),
  },
  { additionalProperties: false },
);

/** Operator response for a pending one-shot secret request. */
export const OperatorSecretResolveParamsSchema = Type.Object(
  {
    id: NonEmptyString,
    value: Type.Optional(Type.String()),
    cancelled: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);

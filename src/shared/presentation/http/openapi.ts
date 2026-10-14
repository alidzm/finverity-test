import type { SchemaObject } from '@nestjs/swagger';
import { z } from 'zod';

/** Converts a zod schema into an OpenAPI 3.0 schema object for `@ApiBody` / `@ApiResponse`. */
export function openApiSchema(schema: z.ZodType): SchemaObject {
  const { $schema: _ignored, ...jsonSchema } = z.toJSONSchema(schema, {
    target: 'openapi-3.0',
    io: 'input',
    unrepresentable: 'any',
  }) as Record<string, unknown>;
  return jsonSchema as SchemaObject;
}

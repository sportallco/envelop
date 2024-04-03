import { GraphQLSchema } from 'graphql';
import { CacheControlDirective } from './plugin';

export declare const getScopeFromQuery: (
  schema: GraphQLSchema,
  query: string,
) => NonNullable<CacheControlDirective['scope']>;

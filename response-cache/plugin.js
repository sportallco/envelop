"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.cacheControlDirective = exports.resultWithMetadata = exports.useResponseCache = exports.isPrivate = exports.schema = exports.defaultGetDocumentString = exports.defaultShouldCacheResult = exports.defaultBuildResponseCacheKey = void 0;
const tslib_1 = require("tslib");
const fast_json_stable_stringify_1 = tslib_1.__importDefault(require("fast-json-stable-stringify"));
const graphql_1 = require("graphql");
const core_1 = require("@envelop/core");
const utils_1 = require("@graphql-tools/utils");
const get_scope_js_1 = require("./get-scope.js");
const hash_sha256_js_1 = require("./hash-sha256.js");
const in_memory_cache_js_1 = require("./in-memory-cache.js");
/**
 * Default function used for building the response cache key.
 * It is exported here for advanced use-cases. E.g. if you want to short circuit and serve responses from the cache on a global level in order to completely by-pass the GraphQL flow.
 */
const defaultBuildResponseCacheKey = (params) => (0, hash_sha256_js_1.hashSHA256)([
    params.documentString,
    params.operationName ?? '',
    (0, fast_json_stable_stringify_1.default)(params.variableValues ?? {}),
    params.sessionId ?? '',
].join('|'));
exports.defaultBuildResponseCacheKey = defaultBuildResponseCacheKey;
/**
 * Default function used to check if the result should be cached.
 *
 * It is exported here for advanced use-cases. E.g. if you want to choose if
 * results with certain error types should be cached.
 *
 * By default, results with errors (unexpected, EnvelopError, or GraphQLError) are not cached.
 */
const defaultShouldCacheResult = (params) => {
    if (params.result.errors) {
        // eslint-disable-next-line no-console
        console.warn('[useResponseCache] Failed to cache due to errors');
        return false;
    }
    return true;
};
exports.defaultShouldCacheResult = defaultShouldCacheResult;
function defaultGetDocumentString(executionArgs) {
    return (0, core_1.getDocumentString)(executionArgs.document, graphql_1.print);
}
exports.defaultGetDocumentString = defaultGetDocumentString;
const getDocumentWithMetadataAndTTL = (0, utils_1.memoize4)(function addTypeNameToDocument(document, { invalidateViaMutation, ttlPerSchemaCoordinate, }, schema, idFieldByTypeName) {
    const typeInfo = new graphql_1.TypeInfo(schema);
    let ttl;
    const visitor = {
        OperationDefinition: {
            enter(node) {
                if (!invalidateViaMutation && node.operation === 'mutation') {
                    return false;
                }
                if (node.operation === 'subscription') {
                    return false;
                }
            },
        },
        ...(ttlPerSchemaCoordinate != null && {
            Field(fieldNode) {
                const parentType = typeInfo.getParentType();
                if (parentType) {
                    const schemaCoordinate = `${parentType.name}.${fieldNode.name.value}`;
                    const maybeTtl = ttlPerSchemaCoordinate[schemaCoordinate];
                    ttl = calculateTtl(maybeTtl, ttl);
                }
            },
        }),
        SelectionSet(node, _key) {
            const parentType = typeInfo.getParentType();
            const idField = parentType && idFieldByTypeName.get(parentType.name);
            return {
                ...node,
                selections: [
                    {
                        kind: graphql_1.Kind.FIELD,
                        name: {
                            kind: graphql_1.Kind.NAME,
                            value: '__typename',
                        },
                        alias: {
                            kind: graphql_1.Kind.NAME,
                            value: '__responseCacheTypeName',
                        },
                    },
                    ...(idField
                        ? [
                            {
                                kind: graphql_1.Kind.FIELD,
                                name: { kind: graphql_1.Kind.NAME, value: idField },
                                alias: { kind: graphql_1.Kind.NAME, value: '__responseCacheId' },
                            },
                        ]
                        : []),
                    ...node.selections,
                ],
            };
        },
    };
    return [(0, graphql_1.visit)(document, (0, graphql_1.visitWithTypeInfo)(typeInfo, visitor)), ttl];
});
let ttlPerSchemaCoordinate = {};
let scopePerSchemaCoordinate = {};
function isPrivate(typeName, data) {
    if (scopePerSchemaCoordinate[typeName] === 'PRIVATE') {
        return true;
    }
    return data
        ? Object.keys(data).some(fieldName => scopePerSchemaCoordinate[`${typeName}.${fieldName}`] === 'PRIVATE')
        : false;
}
exports.isPrivate = isPrivate;
function useResponseCache({ cache = (0, in_memory_cache_js_1.createInMemoryCache)(), ttl: globalTtl = Infinity, session, enabled, ignoredTypes = [], ttlPerType = {}, ttlPerSchemaCoordinate: localTtlPerSchemaCoordinate = {}, scopePerSchemaCoordinate: localScopePerSchemaCoordinate = {}, idFields = ['id'], invalidateViaMutation = true, buildResponseCacheKey = exports.defaultBuildResponseCacheKey, getDocumentString = defaultGetDocumentString, shouldCacheResult = exports.defaultShouldCacheResult, includeExtensionMetadata = typeof process !== 'undefined'
    ? // eslint-disable-next-line dot-notation
        process.env['NODE_ENV'] === 'development' || !!process.env['DEBUG']
    : false, }) {
    const ignoredTypesMap = new Set(ignoredTypes);
    const typePerSchemaCoordinateMap = new Map();
    enabled = enabled ? (0, utils_1.memoize1)(enabled) : enabled;
    // never cache Introspections
    ttlPerSchemaCoordinate = { 'Query.__schema': 0, ...localTtlPerSchemaCoordinate };
    const documentMetadataOptions = {
        queries: { invalidateViaMutation, ttlPerSchemaCoordinate },
        mutations: { invalidateViaMutation }, // remove ttlPerSchemaCoordinate for mutations to skip TTL calculation
    };
    scopePerSchemaCoordinate = { ...localScopePerSchemaCoordinate };
    const idFieldByTypeName = new Map();
    return {
        onSchemaChange({ schema: newSchema }) {
            if (exports.schema === newSchema) {
                return;
            }
            exports.schema = newSchema;
            const directive = exports.schema.getDirective('cacheControl');
            (0, utils_1.mapSchema)(exports.schema, {
                ...(directive && {
                    [utils_1.MapperKind.COMPOSITE_TYPE]: type => {
                        const cacheControlAnnotations = (0, utils_1.getDirective)(exports.schema, type, 'cacheControl');
                        cacheControlAnnotations?.forEach(cacheControl => {
                            if (cacheControl.maxAge != null) {
                                ttlPerType[type.name] = cacheControl.maxAge * 1000;
                            }
                            if (cacheControl.scope) {
                                scopePerSchemaCoordinate[type.name] = cacheControl.scope;
                            }
                        });
                        return type;
                    },
                }),
                [utils_1.MapperKind.FIELD]: (fieldConfig, fieldName, typeName) => {
                    const schemaCoordinates = `${typeName}.${fieldName}`;
                    const resultTypeNames = unwrapTypenames(fieldConfig.type);
                    typePerSchemaCoordinateMap.set(schemaCoordinates, resultTypeNames);
                    if (idFields.includes(fieldName) && !idFieldByTypeName.has(typeName)) {
                        idFieldByTypeName.set(typeName, fieldName);
                    }
                    if (directive) {
                        const cacheControlAnnotations = (0, utils_1.getDirective)(exports.schema, fieldConfig, 'cacheControl');
                        cacheControlAnnotations?.forEach(cacheControl => {
                            if (cacheControl.maxAge != null) {
                                ttlPerSchemaCoordinate[schemaCoordinates] = cacheControl.maxAge * 1000;
                            }
                            if (cacheControl.scope) {
                                scopePerSchemaCoordinate[schemaCoordinates] = cacheControl.scope;
                            }
                        });
                    }
                    return fieldConfig;
                },
            });
        },
        async onExecute(onExecuteParams) {
            if (enabled && !enabled(onExecuteParams.args.contextValue)) {
                return;
            }
            const identifier = new Map();
            const types = new Set();
            let currentTtl;
            let skip = false;
            const sessionId = session(onExecuteParams.args.contextValue);
            function setExecutor({ execute, onExecuteDone, }) {
                let executed = false;
                onExecuteParams.setExecuteFn(args => {
                    executed = true;
                    return execute(args);
                });
                return {
                    onExecuteDone(params) {
                        if (!executed) {
                            // eslint-disable-next-line no-console
                            console.warn('[useResponseCache] The cached execute function was not called, another plugin might have overwritten it. Please check your plugin order.');
                        }
                        return onExecuteDone?.(params);
                    },
                };
            }
            function processResult(data) {
                if (data == null || typeof data !== 'object') {
                    return;
                }
                if (Array.isArray(data)) {
                    for (const item of data) {
                        processResult(item);
                    }
                    return;
                }
                const typename = data.__responseCacheTypeName;
                delete data.__responseCacheTypeName;
                const entityId = data.__responseCacheId;
                delete data.__responseCacheId;
                // Always process nested objects, even if we are skipping cache, to ensure the result is cleaned up
                // of metadata fields added to the query document.
                for (const fieldName in data) {
                    processResult(data[fieldName]);
                }
                if (!skip) {
                    if (ignoredTypesMap.has(typename) || (!sessionId && isPrivate(typename, data))) {
                        skip = true;
                        return;
                    }
                    types.add(typename);
                    if (typename in ttlPerType) {
                        const maybeTtl = ttlPerType[typename];
                        currentTtl = calculateTtl(maybeTtl, currentTtl);
                    }
                    if (entityId != null) {
                        identifier.set(`${typename}:${entityId}`, { typename, id: entityId });
                    }
                    for (const fieldName in data) {
                        const fieldData = data[fieldName];
                        if (fieldData == null || (Array.isArray(fieldData) && fieldData.length === 0)) {
                            const inferredTypes = typePerSchemaCoordinateMap.get(`${typename}.${fieldName}`);
                            inferredTypes?.forEach(inferredType => {
                                if (inferredType in ttlPerType) {
                                    const maybeTtl = ttlPerType[inferredType];
                                    currentTtl = calculateTtl(maybeTtl, currentTtl);
                                }
                                identifier.set(inferredType, { typename: inferredType });
                            });
                        }
                    }
                }
            }
            function invalidateCache(result, setResult) {
                processResult(result.data);
                cache.invalidate(identifier.values());
                if (includeExtensionMetadata) {
                    setResult(resultWithMetadata(result, {
                        invalidatedEntities: Array.from(identifier.values()),
                    }));
                }
            }
            if (invalidateViaMutation !== false) {
                const operationAST = (0, graphql_1.getOperationAST)(onExecuteParams.args.document, onExecuteParams.args.operationName);
                if (operationAST?.operation === 'mutation') {
                    return setExecutor({
                        execute(args) {
                            const [document] = getDocumentWithMetadataAndTTL(args.document, documentMetadataOptions.mutations, args.schema, idFieldByTypeName);
                            return onExecuteParams.executeFn({ ...args, document });
                        },
                        onExecuteDone({ result, setResult }) {
                            if ((0, core_1.isAsyncIterable)(result)) {
                                return handleAsyncIterableResult(invalidateCache);
                            }
                            return invalidateCache(result, setResult);
                        },
                    });
                }
            }
            const cacheKey = await buildResponseCacheKey({
                documentString: getDocumentString(onExecuteParams.args),
                variableValues: onExecuteParams.args.variableValues,
                operationName: onExecuteParams.args.operationName,
                sessionId,
                context: onExecuteParams.args.contextValue,
                getScope: () => (0, get_scope_js_1.getScopeFromQuery)(exports.schema, onExecuteParams.args.document.loc.source.body),
            });
            const cachedResponse = (await cache.get(cacheKey));
            if (cachedResponse != null) {
                return setExecutor({
                    execute: () => includeExtensionMetadata
                        ? resultWithMetadata(cachedResponse, { hit: true })
                        : cachedResponse,
                });
            }
            function maybeCacheResult(result, setResult) {
                processResult(result.data);
                // we only use the global ttl if no currentTtl has been determined.
                const finalTtl = currentTtl ?? globalTtl;
                if (skip || !shouldCacheResult({ cacheKey, result }) || finalTtl === 0) {
                    if (includeExtensionMetadata) {
                        setResult(resultWithMetadata(result, { hit: false, didCache: false }));
                    }
                    return;
                }
                cache.set(cacheKey, result, identifier.values(), finalTtl);
                if (includeExtensionMetadata) {
                    setResult(resultWithMetadata(result, { hit: false, didCache: true, ttl: finalTtl }));
                }
            }
            return setExecutor({
                execute(args) {
                    const [document, ttl] = getDocumentWithMetadataAndTTL(args.document, documentMetadataOptions.queries, exports.schema, idFieldByTypeName);
                    currentTtl = ttl;
                    return onExecuteParams.executeFn({ ...args, document });
                },
                onExecuteDone({ result, setResult }) {
                    if ((0, core_1.isAsyncIterable)(result)) {
                        return handleAsyncIterableResult(maybeCacheResult);
                    }
                    return maybeCacheResult(result, setResult);
                },
            });
        },
    };
}
exports.useResponseCache = useResponseCache;
function handleAsyncIterableResult(handler) {
    // When the result is an AsyncIterable, it means the query is using @defer or @stream.
    // This means we have to build the final result by merging the incremental results.
    // The merged result is then used to know if we should cache it and to calculate the ttl.
    const result = {};
    return {
        onNext(payload) {
            const { data, errors, extensions } = payload.result;
            // This is the first result with the initial data payload sent to the client. We use it as the base result
            if (data) {
                result.data = data;
            }
            if (errors) {
                result.errors = errors;
            }
            if (extensions) {
                result.extensions = extensions;
            }
            if ('hasNext' in payload.result) {
                const { incremental, hasNext } = payload.result;
                if (incremental) {
                    for (const patch of incremental) {
                        (0, utils_1.mergeIncrementalResult)({ executionResult: result, incrementalResult: patch });
                    }
                }
                if (!hasNext) {
                    // The query is complete, we can process the final result
                    handler(result, payload.setResult);
                }
            }
        },
    };
}
function resultWithMetadata(result, metadata) {
    return {
        ...result,
        extensions: {
            ...result.extensions,
            responseCache: {
                ...result.extensions?.responseCache,
                ...metadata,
            },
        },
    };
}
exports.resultWithMetadata = resultWithMetadata;
function calculateTtl(typeTtl, currentTtl) {
    if (typeof typeTtl === 'number' && !Number.isNaN(typeTtl)) {
        if (typeof currentTtl === 'number') {
            return Math.min(currentTtl, typeTtl);
        }
        return typeTtl;
    }
    return currentTtl;
}
function unwrapTypenames(type) {
    if (type.ofType) {
        return unwrapTypenames(type.ofType);
    }
    if (type._types) {
        return type._types.map((t) => unwrapTypenames(t)).flat();
    }
    return [type.name];
}
exports.cacheControlDirective = `
  enum CacheControlScope {
    PUBLIC
    PRIVATE
  }

  directive @cacheControl(maxAge: Int, scope: CacheControlScope) on FIELD_DEFINITION | OBJECT
`;

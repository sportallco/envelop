"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getScopeFromQuery = void 0;
const graphql_1 = require("graphql");
const utils_1 = require("@graphql-tools/utils");
const plugin_1 = require("./plugin");
/** Parse the selected query fields */
function parseSelections(selections = [], record) {
    for (const selection of selections) {
        if (selection.kind === graphql_1.Kind.FIELD) {
            record[selection.name.value] = {};
            parseSelections(selection.selectionSet?.selections, record[selection.name.value]);
        }
    }
}
/** Iterate over record and parse its fields with schema type */
function parseRecordWithSchemaType(type, record, prefix) {
    let fields = new Set();
    if (type instanceof graphql_1.GraphQLNonNull || type instanceof graphql_1.GraphQLList) {
        fields = new Set([...fields, ...parseRecordWithSchemaType(type.ofType, record, prefix)]);
    }
    if (type instanceof graphql_1.GraphQLObjectType) {
        const newPrefixes = [...(prefix ?? []), type.name];
        fields.add(newPrefixes.join('.'));
        const typeFields = type.getFields();
        for (const key of Object.keys(record)) {
            const field = typeFields[key];
            if (!field) {
                continue;
            }
            fields.add([...newPrefixes, field.name].join('.'));
            if (Object.keys(record[key]).length > 0) {
                fields = new Set([...fields, ...parseRecordWithSchemaType(field.type, record[key])]);
            }
        }
    }
    return fields;
}
function getSchemaCoordinatesFromQuery(schema, query) {
    const ast = (0, graphql_1.parse)(query);
    let fields = new Set();
    const visitField = (node) => {
        const record = {};
        const queryFields = schema.getQueryType()?.getFields()[node.name.value];
        if (queryFields) {
            record[node.name.value] = {};
            parseSelections(node.selectionSet?.selections, record[node.name.value]);
            fields.add(`Query.${node.name.value}`);
            fields = new Set([
                ...fields,
                ...parseRecordWithSchemaType(queryFields.type, record[node.name.value]),
            ]);
        }
    };
    // Launch the field visitor
    (0, graphql_1.visit)(ast, {
        Field: visitField,
    });
    return fields;
}
const getScopeFromQuery = (schema, query) => {
    const fn = (0, utils_1.memoize1)(({ query }) => {
        const schemaCoordinates = getSchemaCoordinatesFromQuery(schema, query);
        for (const coordinate of schemaCoordinates) {
            if ((0, plugin_1.isPrivate)(coordinate)) {
                return 'PRIVATE';
            }
        }
        return 'PUBLIC';
    });
    return fn({ query });
};
exports.getScopeFromQuery = getScopeFromQuery;

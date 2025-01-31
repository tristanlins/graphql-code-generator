import {
  SelectionSetNode,
  Kind,
  FieldNode,
  FragmentSpreadNode,
  InlineFragmentNode,
  GraphQLNamedType,
  isObjectType,
  isUnionType,
  isInterfaceType,
  GraphQLSchema,
  GraphQLField,
  SchemaMetaFieldDef,
  TypeMetaFieldDef,
  SelectionNode,
  isListType,
  isNonNullType,
  GraphQLObjectType,
  GraphQLOutputType,
} from 'graphql';
import { getPossibleTypes, separateSelectionSet, getFieldNodeNameValue, DeclarationBlock, mergeSelectionSets } from './utils';
import { NormalizedScalarsMap, ConvertNameFn, LoadedFragment } from './types';
import { BaseVisitorConvertOptions } from './base-visitor';
import { getBaseType } from '@graphql-codegen/plugin-helpers';
import { ParsedDocumentsConfig } from './base-documents-visitor';
import { LinkField, PrimitiveAliasedFields, PrimitiveField, BaseSelectionSetProcessor, ProcessResult, NameAndType } from './selection-set-processor/base';

function isMetadataFieldName(name: string) {
  return ['__schema', '__type'].includes(name);
}

const metadataFieldMap: Record<string, GraphQLField<any, any>> = {
  __schema: SchemaMetaFieldDef,
  __type: TypeMetaFieldDef,
};

export class SelectionSetToObject<Config extends ParsedDocumentsConfig = ParsedDocumentsConfig> {
  protected _primitiveFields: PrimitiveField[] = [];
  protected _primitiveAliasedFields: PrimitiveAliasedFields[] = [];
  protected _linksFields: LinkField[] = [];
  protected _queriedForTypename = false;

  constructor(
    protected _processor: BaseSelectionSetProcessor<any>,
    protected _scalars: NormalizedScalarsMap,
    protected _schema: GraphQLSchema,
    protected _convertName: ConvertNameFn<BaseVisitorConvertOptions>,
    protected _loadedFragments: LoadedFragment[],
    protected _config: Config,
    protected _parentSchemaType?: GraphQLNamedType,
    protected _selectionSet?: SelectionSetNode
  ) {}

  public createNext(parentSchemaType: GraphQLNamedType, selectionSet: SelectionSetNode): SelectionSetToObject {
    return new SelectionSetToObject(this._processor, this._scalars, this._schema, this._convertName, this._loadedFragments, this._config, parentSchemaType, selectionSet);
  }

  /**
   * traverse the inline fragment nodes recursively for colleting the selectionSets on each type
   */
  _collectInlineFragments(parentType: GraphQLNamedType, nodes: InlineFragmentNode[], types: Map<string, Array<SelectionNode | string>>) {
    if (isListType(parentType) || isNonNullType(parentType)) {
      return this._collectInlineFragments(parentType.ofType, nodes, types);
    } else if (isObjectType(parentType)) {
      for (const node of nodes) {
        const typeOnSchema = node.typeCondition ? this._schema.getType(node.typeCondition.name.value) : parentType;
        const { fields, inlines, spreads } = separateSelectionSet(node.selectionSet.selections);
        const spreadsUsage = this.buildFragmentSpreadsUsage(spreads);

        if (isObjectType(typeOnSchema)) {
          this._appendToTypeMap(types, typeOnSchema.name, fields);
          this._appendToTypeMap(types, typeOnSchema.name, spreadsUsage[typeOnSchema.name]);
          this._collectInlineFragments(typeOnSchema, inlines, types);
        } else if (isInterfaceType(typeOnSchema) && parentType.isTypeOf(typeOnSchema, null, null)) {
          this._appendToTypeMap(types, parentType.name, fields);
          this._appendToTypeMap(types, parentType.name, spreadsUsage[parentType.name]);
          this._collectInlineFragments(typeOnSchema, inlines, types);
        }
      }
    } else if (isInterfaceType(parentType)) {
      const possibleTypes = getPossibleTypes(this._schema, parentType);

      for (const node of nodes) {
        const schemaType = node.typeCondition ? this._schema.getType(node.typeCondition.name.value) : parentType;
        const { fields, inlines, spreads } = separateSelectionSet(node.selectionSet.selections);
        const spreadsUsage = this.buildFragmentSpreadsUsage(spreads);

        if (isObjectType(schemaType) && possibleTypes.find(possibleType => possibleType.name === schemaType.name)) {
          this._appendToTypeMap(types, schemaType.name, fields);
          this._appendToTypeMap(types, schemaType.name, spreadsUsage[schemaType.name]);
          this._collectInlineFragments(schemaType, inlines, types);
        } else if (isInterfaceType(schemaType) && schemaType.name === parentType.name) {
          for (const possibleType of possibleTypes) {
            this._appendToTypeMap(types, possibleType.name, fields);
            this._appendToTypeMap(types, possibleType.name, spreadsUsage[possibleType.name]);
            this._collectInlineFragments(schemaType, inlines, types);
          }
        }
      }
    } else if (isUnionType(parentType)) {
      const possibleTypes = parentType.getTypes();

      for (const node of nodes) {
        const schemaType = node.typeCondition ? this._schema.getType(node.typeCondition.name.value) : parentType;
        const { fields, inlines, spreads } = separateSelectionSet(node.selectionSet.selections);
        const spreadsUsage = this.buildFragmentSpreadsUsage(spreads);

        if (isObjectType(schemaType) && possibleTypes.find(possibleType => possibleType.name === schemaType.name)) {
          this._appendToTypeMap(types, schemaType.name, fields);
          this._appendToTypeMap(types, schemaType.name, spreadsUsage[schemaType.name]);
          this._collectInlineFragments(schemaType, inlines, types);
        } else if (isInterfaceType(schemaType)) {
          const possibleInterfaceTypes = getPossibleTypes(this._schema, schemaType);

          for (const possibleType of possibleTypes) {
            if (possibleInterfaceTypes.find(possibleInterfaceType => possibleInterfaceType.name === possibleType.name)) {
              this._appendToTypeMap(types, possibleType.name, fields);
              this._appendToTypeMap(types, possibleType.name, spreadsUsage[possibleType.name]);
              this._collectInlineFragments(schemaType, inlines, types);
            }
          }
        }
      }
    }
  }

  protected _createInlineFragmentForFieldNodes(parentType: GraphQLNamedType, fieldNodes: FieldNode[]): InlineFragmentNode {
    return {
      kind: Kind.INLINE_FRAGMENT,
      typeCondition: {
        kind: Kind.NAMED_TYPE,
        name: {
          kind: Kind.NAME,
          value: parentType.name,
        },
      },
      directives: [],
      selectionSet: {
        kind: Kind.SELECTION_SET,
        selections: fieldNodes,
      },
    };
  }

  protected buildFragmentSpreadsUsage(spreads: FragmentSpreadNode[]): Record<string, string[]> {
    const selectionNodesByTypeName = {};

    for (const spread of spreads) {
      const fragmentSpreadObject = this._loadedFragments.find(lf => lf.name === spread.name.value);

      if (fragmentSpreadObject) {
        const schemaType = this._schema.getType(fragmentSpreadObject.onType);
        const possibleTypesForFragment = getPossibleTypes(this._schema, schemaType);

        for (const possibleType of possibleTypesForFragment) {
          const fragmentSuffix = this._config.dedupeOperationSuffix && spread.name.value.toLowerCase().endsWith('fragment') ? '' : 'Fragment';
          const usage = this.buildFragmentTypeName(spread.name.value, fragmentSuffix, possibleTypesForFragment.length === 1 ? null : possibleType.name);

          if (!selectionNodesByTypeName[possibleType.name]) {
            selectionNodesByTypeName[possibleType.name] = [];
          }

          selectionNodesByTypeName[possibleType.name].push(usage);
        }
      }
    }

    return selectionNodesByTypeName;
  }

  protected flattenSelectionSet(selections: ReadonlyArray<SelectionNode>): Map<string, Array<SelectionNode | string>> {
    const selectionNodesByTypeName = new Map<string, Array<SelectionNode | string>>();
    const inlineFragmentSelections: InlineFragmentNode[] = [];
    const fieldNodes: FieldNode[] = [];
    const fragmentSpreads: FragmentSpreadNode[] = [];

    for (const selection of selections) {
      switch (selection.kind) {
        case Kind.FIELD:
          fieldNodes.push(selection);
          break;
        case Kind.INLINE_FRAGMENT:
          inlineFragmentSelections.push(selection);
          break;
        case Kind.FRAGMENT_SPREAD:
          fragmentSpreads.push(selection);
          break;
      }
    }

    if (fieldNodes.length) {
      inlineFragmentSelections.push(this._createInlineFragmentForFieldNodes(this._parentSchemaType, fieldNodes));
    }

    this._collectInlineFragments(this._parentSchemaType, inlineFragmentSelections, selectionNodesByTypeName);
    const fragmentsUsage = this.buildFragmentSpreadsUsage(fragmentSpreads);

    Object.keys(fragmentsUsage).forEach(typeName => {
      this._appendToTypeMap(selectionNodesByTypeName, typeName, fragmentsUsage[typeName]);
    });

    return selectionNodesByTypeName;
  }

  private _appendToTypeMap<T = SelectionNode | string>(types: Map<string, Array<T>>, typeName: string, nodes: Array<T>): void {
    if (!types.has(typeName)) {
      types.set(typeName, []);
    }

    if (nodes && nodes.length > 0) {
      types.get(typeName).push(...nodes);
    }
  }

  protected _buildGroupedSelections(): Record<string, string[]> {
    if (!this._selectionSet || !this._selectionSet.selections || this._selectionSet.selections.length === 0) {
      return {};
    }

    const selectionNodesByTypeName = this.flattenSelectionSet(this._selectionSet.selections);

    const grouped = getPossibleTypes(this._schema, this._parentSchemaType).reduce(
      (prev, type) => {
        const typeName = type.name;
        const schemaType = this._schema.getType(typeName);

        if (!isObjectType(schemaType)) {
          throw new TypeError(`Invalid state! Schema type ${typeName} is not a valid GraphQL object!`);
        }

        const selectionNodes = selectionNodesByTypeName.get(typeName) || [];

        if (!prev[typeName]) {
          prev[typeName] = [];
        }

        const transformedSet = this.buildSelectionSetString(schemaType, selectionNodes);

        if (transformedSet) {
          prev[typeName].push(transformedSet);
        }

        return prev;
      },
      {} as Record<string, string[]>
    );

    return grouped;
  }

  protected buildSelectionSetString(parentSchemaType: GraphQLObjectType, selectionNodes: Array<SelectionNode | string>) {
    const primitiveFields = new Map<string, FieldNode>();
    const primitiveAliasFields = new Map<string, FieldNode>();
    const linkFieldSelectionSets = new Map<
      string,
      {
        selectedFieldType: GraphQLOutputType;
        field: FieldNode;
      }
    >();
    let requireTypename = false;
    const fragmentsSpreadUsages: string[] = [];

    for (const selectionNode of selectionNodes) {
      if (typeof selectionNode === 'string') {
        fragmentsSpreadUsages.push(selectionNode);
      } else if (selectionNode.kind === 'Field') {
        if (!selectionNode.selectionSet) {
          if (selectionNode.alias) {
            primitiveAliasFields.set(selectionNode.alias.value, selectionNode);
          } else if (selectionNode.name.value === '__typename') {
            requireTypename = true;
          } else {
            primitiveFields.set(selectionNode.name.value, selectionNode);
          }
        } else {
          let selectedField: GraphQLField<any, any, any> = null;

          const fields = parentSchemaType.getFields();
          selectedField = fields[selectionNode.name.value];

          if (isMetadataFieldName(selectionNode.name.value)) {
            selectedField = metadataFieldMap[selectionNode.name.value];
          }

          if (!selectedField) {
            throw new TypeError(`Could not find field type. ${parentSchemaType}.${selectionNode.name.value}`);
          }

          const fieldName = getFieldNodeNameValue(selectionNode);
          let linkFieldNode = linkFieldSelectionSets.get(fieldName);
          if (!linkFieldNode) {
            linkFieldNode = {
              selectedFieldType: selectedField.type,
              field: selectionNode,
            };
            linkFieldSelectionSets.set(fieldName, linkFieldNode);
          } else {
            mergeSelectionSets(linkFieldNode.field.selectionSet, selectionNode.selectionSet);
          }
        }
      }
    }

    const linkFields: LinkField[] = [];
    for (const { field, selectedFieldType } of linkFieldSelectionSets.values()) {
      const realSelectedFieldType = getBaseType(selectedFieldType as any);
      const selectionSet = this.createNext(realSelectedFieldType, field.selectionSet);

      linkFields.push({
        alias: field.alias ? field.alias.value : undefined,
        name: field.name.value,
        type: realSelectedFieldType.name,
        selectionSet: this._processor.config.wrapTypeWithModifiers(
          selectionSet
            .transformSelectionSet()
            .split(`\n`)
            .join(`\n  `),
          selectedFieldType as any
        ),
      });
    }

    const typeInfoField = this.buildTypeNameField(parentSchemaType, this._config.nonOptionalTypename, this._config.addTypename, requireTypename);
    const transformed: ProcessResult = [
      ...(typeInfoField ? this._processor.transformTypenameField(typeInfoField.type, typeInfoField.name) : []),
      ...this._processor.transformPrimitiveFields(parentSchemaType, Array.from(primitiveFields.values()).map(field => field.name.value)),
      ...this._processor.transformAliasesPrimitiveFields(parentSchemaType, Array.from(primitiveAliasFields.values()).map(field => ({ alias: field.alias.value, fieldName: field.name.value }))),
      ...this._processor.transformLinkFields(linkFields),
    ].filter(Boolean);

    const allStrings: string[] = transformed.filter(t => typeof t === 'string') as string[];
    const allObjectsMerged: string[] = transformed.filter(t => typeof t !== 'string').map((t: NameAndType) => `${t.name}: ${t.type}`);
    let mergedObjectsAsString: string = null;

    if (allObjectsMerged.length > 0) {
      mergedObjectsAsString = `{ ${allObjectsMerged.join(', ')} }`;
    }

    const fields = [...allStrings, mergedObjectsAsString, ...fragmentsSpreadUsages].filter(Boolean);

    if (fields.length === 0) {
      return null;
    } else if (fields.length === 1) {
      return fields[0];
    } else {
      return `(\n  ${fields.join(`\n  & `)}\n)`;
    }
  }

  protected buildTypeNameField(
    type: GraphQLObjectType,
    nonOptionalTypename: boolean = this._config.nonOptionalTypename,
    addTypename: boolean = this._config.addTypename,
    queriedForTypename: boolean = this._queriedForTypename
  ): { name: string; type: string } {
    if (nonOptionalTypename || addTypename || queriedForTypename) {
      const optionalTypename = !queriedForTypename && !nonOptionalTypename;

      return {
        name: `${this._processor.config.formatNamedField('__typename')}${optionalTypename ? '?' : ''}`,
        type: `'${type.name}'`,
      };
    }

    return null;
  }

  public transformSelectionSet(): string {
    const grouped = this._buildGroupedSelections();

    return Object.keys(grouped)
      .map(typeName => {
        const relevant = grouped[typeName].filter(Boolean);

        if (relevant.length === 0) {
          return null;
        } else if (relevant.length === 1) {
          return relevant[0];
        } else {
          return `( ${relevant.join(' & ')} )`;
        }
      })
      .filter(Boolean)
      .join(' | ');
  }

  public transformFragmentSelectionSetToTypes(fragmentName: string, fragmentSuffix: string, declarationBlockConfig): string {
    const grouped = this._buildGroupedSelections();

    const subTypes: { name: string; content: string }[] = Object.keys(grouped)
      .map(typeName => {
        const possibleFields = grouped[typeName].filter(Boolean);

        if (possibleFields.length === 0) {
          return null;
        }

        const declarationName = this.buildFragmentTypeName(fragmentName, fragmentSuffix, typeName);

        return { name: declarationName, content: possibleFields.join(' & ') };
      })
      .filter(Boolean);

    if (subTypes.length === 1) {
      return new DeclarationBlock(declarationBlockConfig)
        .export()
        .asKind('type')
        .withName(this.buildFragmentTypeName(fragmentName, fragmentSuffix))
        .withContent(subTypes[0].content).string;
    }

    return [
      ...subTypes.map(
        t =>
          new DeclarationBlock(declarationBlockConfig)
            .export(this._config.exportFragmentSpreadSubTypes)
            .asKind('type')
            .withName(t.name)
            .withContent(t.content).string
      ),
      new DeclarationBlock(declarationBlockConfig)
        .export()
        .asKind('type')
        .withName(this.buildFragmentTypeName(fragmentName, fragmentSuffix))
        .withContent(subTypes.map(t => t.name).join(' | ')).string,
    ].join('\n');
  }

  protected buildFragmentTypeName(name: string, suffix: string, typeName = ''): string {
    return this._convertName(name, {
      useTypesPrefix: true,
      suffix: typeName ? `_${typeName}_${suffix}` : suffix,
    });
  }
}

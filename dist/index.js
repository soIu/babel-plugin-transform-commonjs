"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const helper_plugin_utils_1 = require("@babel/helper-plugin-utils");
const core_1 = require("@babel/core");
exports.default = helper_plugin_utils_1.declare((api, options) => {
    api.assertVersion(7);
    const state = {
        globals: new Set(),
        renamed: new Map(),
        identifiers: new Set(),
        isCJS: false,
    };
    const enter = path => {
        let cursor = path;
        // Find the closest function scope or parent.
        do {
            // Ignore block statements.
            if (core_1.types.isBlockStatement(cursor.scope.path)) {
                continue;
            }
            if (core_1.types.isFunction(cursor.scope.path) || core_1.types.isProgram(cursor.scope.path)) {
                break;
            }
        } while (cursor = cursor.scope.path.parentPath);
        if (core_1.types.isProgram(cursor.scope.path)) {
            const nodes = [];
            const inner = [];
            // Break up the program, separate Nodes added by us from the nodes
            // created by the user.
            cursor.scope.path.node.body.filter(node => {
                // Keep replaced nodes together, these will not be wrapped.
                if (node.__replaced) {
                    nodes.push(node);
                }
                else {
                    inner.push(node);
                }
            });
            const program = core_1.types.program([
                ...nodes,
                core_1.types.expressionStatement(core_1.types.callExpression(core_1.types.memberExpression(core_1.types.functionExpression(null, [], core_1.types.blockStatement(inner)), core_1.types.identifier('call')), [core_1.types.identifier('module.exports')])),
            ]);
            cursor.scope.path.replaceWith(program);
            state.isCJS = true;
        }
    };
    return {
        post() {
            state.globals.clear();
            state.renamed.clear();
            state.identifiers.clear();
            state.isCJS = false;
        },
        visitor: {
            Program: {
                exit(path) {
                    path.traverse({
                        CallExpression: {
                            exit(path) {
                                const { node } = path;
                                // Look for `require()` any renaming is assumed to be intentionally
                                // done to break state kind of check, so we won't look for aliases.
                                if (!options.exportsOnly && core_1.types.isIdentifier(node.callee) && node.callee.name === 'require') {
                                    // Require must be global for us to consider this a CommonJS
                                    // module.
                                    state.isCJS = true;
                                    // Check for nested string and template literals.
                                    const isString = core_1.types.isStringLiteral(node.arguments[0]);
                                    const isLiteral = core_1.types.isTemplateLiteral(node.arguments[0]);
                                    // Normalize the string value, default to the standard string
                                    // literal format of `{ value: "" }`.
                                    let str = null;
                                    if (isString) {
                                        str = node.arguments[0];
                                    }
                                    else if (isLiteral) {
                                        str = {
                                            value: node.arguments[0].quasis[0].value.raw,
                                        };
                                    }
                                    else if (options.synchronousImport) {
                                        const str = node.arguments[0];
                                        const newNode = core_1.types.expressionStatement(core_1.types.callExpression(core_1.types.import(), [str]));
                                        // @ts-ignore
                                        newNode.__replaced = true;
                                        path.replaceWith(newNode);
                                        return;
                                    }
                                    else {
                                        throw new Error(`Invalid require signature: ${path.toString()}`);
                                    }
                                    const specifiers = [];
                                    // Convert to named import.
                                    if (core_1.types.isObjectPattern(path.parentPath.node.id)) {
                                        path.parentPath.node.id.properties.forEach(prop => {
                                            specifiers.push(core_1.types.importSpecifier(prop.value, prop.key));
                                            state.globals.add(prop.value.name);
                                        });
                                        const decl = core_1.types.importDeclaration(specifiers, core_1.types.stringLiteral(str.value));
                                        // @ts-ignore
                                        decl.__replaced = true;
                                        path.scope.getProgramParent().path.unshiftContainer('body', decl);
                                        path.parentPath.remove();
                                    }
                                    // Convert to default import.
                                    else if (str) {
                                        const { parentPath } = path;
                                        const { left } = parentPath.node;
                                        // @ts-ignore
                                        const oldId = !core_1.types.isMemberExpression(left) ? left : left.id;
                                        // Default to the closest likely identifier.
                                        let id = oldId;
                                        // If we can't find an id, generate one from the import path.
                                        if (!oldId || !core_1.types.isProgram(parentPath.scope.path.type)) {
                                            id = path.scope.generateUidIdentifier(str.value);
                                        }
                                        // Add state global name to the list.
                                        state.globals.add(id.name);
                                        // Create an import declaration.
                                        const decl = core_1.types.importDeclaration([core_1.types.importDefaultSpecifier(id)], core_1.types.stringLiteral(str.value));
                                        // @ts-ignore
                                        decl.__replaced = true;
                                        // Push the declaration in the root scope.
                                        path.scope.getProgramParent().path.unshiftContainer('body', decl);
                                        // If we needed to generate or the change the id, then make an
                                        // assignment so the values stay in sync.
                                        if (oldId && !core_1.types.isNodesEquivalent(oldId, id)) {
                                            const newNode = core_1.types.expressionStatement(core_1.types.assignmentExpression('=', oldId, id));
                                            // @ts-ignore
                                            newNode.__replaced = true;
                                            path.parentPath.parentPath.replaceWith(newNode);
                                        }
                                        // If we generated a new identifier for state, replace the inline
                                        // call with the variable.
                                        else if (!oldId) {
                                            path.replaceWith(id);
                                        }
                                        // Otherwise completely remove.
                                        else {
                                            path.parentPath.remove();
                                        }
                                    }
                                }
                            }
                        },
                    });
                    const programPath = path.scope.getProgramParent().path;
                    // Even though we are pretty sure this isn't a CommonJS file, lets
                    // do one last sanity check for an `import` or `export` in the
                    // program path.
                    if (!state.isCJS) {
                        const lastImport = programPath
                            .get('body')
                            .filter(p => p.isImportDeclaration())
                            .pop();
                        const lastExport = programPath
                            .get('body')
                            .filter(p => p.isExportDeclaration())
                            .pop();
                        // Maybe it is a CJS file after-all.
                        if (!lastImport && !lastExport) {
                            state.isCJS = true;
                        }
                    }
                    if (path.node.__replaced || !state.isCJS) {
                        return;
                    }
                    const exportsAlias = core_1.types.variableDeclaration('var', [
                        core_1.types.variableDeclarator(core_1.types.identifier('exports'), core_1.types.memberExpression(core_1.types.identifier('module'), core_1.types.identifier('exports')))
                    ]);
                    const moduleExportsAlias = core_1.types.variableDeclaration('var', [
                        core_1.types.variableDeclarator(core_1.types.identifier('module'), core_1.types.objectExpression([
                            core_1.types.objectProperty(core_1.types.identifier('exports'), core_1.types.objectExpression([]))
                        ]))
                    ]);
                    // @ts-ignore
                    exportsAlias.__replaced = true;
                    // @ts-ignore
                    moduleExportsAlias.__replaced = true;
                    // Add the `module` and `exports` globals into the program body,
                    // after the last `import` declaration.
                    const lastImport = programPath
                        .get('body')
                        .filter(p => p.isImportDeclaration())
                        .pop();
                    if (lastImport) {
                        lastImport.insertAfter(exportsAlias);
                        lastImport.insertAfter(moduleExportsAlias);
                    }
                    else {
                        programPath.unshiftContainer('body', exportsAlias);
                        programPath.unshiftContainer('body', moduleExportsAlias);
                    }
                    /*const defaultExport = core_1.types.exportDefaultDeclaration(core_1.types.memberExpression(core_1.types.identifier('module'), core_1.types.identifier('exports')));
                    path.node.__replaced = true;
                    // @ts-ignore
                    defaultExport.__replaced = true;
                    programPath.pushContainer('body', defaultExport);*/
                }
            },
            ThisExpression: { enter },
            ReturnStatement: { enter },
            ImportSpecifier: {
                enter(path) {
                    const { name } = path.node.local;
                    // If state import was renamed, ensure the source reflects it.
                    if (state.renamed.has(name)) {
                        const oldName = core_1.types.identifier(name);
                        const newName = core_1.types.identifier(state.renamed.get(name));
                        path.replaceWith(core_1.types.importSpecifier(newName, oldName));
                    }
                }
            }
        },
    };
});
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiaW5kZXguanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyIuLi9saWIvaW5kZXgudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6Ijs7QUFBQSxvRUFBcUQ7QUFDckQsc0NBQXlDO0FBRXpDLGtCQUFlLDZCQUFPLENBQUMsQ0FBQyxHQUFHLEVBQUUsT0FBTyxFQUFFLEVBQUU7SUFDdEMsR0FBRyxDQUFDLGFBQWEsQ0FBQyxDQUFDLENBQUMsQ0FBQztJQUVyQixNQUFNLEtBQUssR0FBRztRQUNaLE9BQU8sRUFBRSxJQUFJLEdBQUcsRUFBRTtRQUNsQixPQUFPLEVBQUUsSUFBSSxHQUFHLEVBQUU7UUFDbEIsV0FBVyxFQUFFLElBQUksR0FBRyxFQUFFO1FBQ3RCLEtBQUssRUFBRSxLQUFLO0tBQ2IsQ0FBQztJQUVGLE1BQU0sS0FBSyxHQUFHLElBQUksQ0FBQyxFQUFFO1FBQ25CLElBQUksTUFBTSxHQUFHLElBQUksQ0FBQztRQUVsQiw2Q0FBNkM7UUFDN0MsR0FBRztZQUNELDJCQUEyQjtZQUMzQixJQUFJLFlBQUMsQ0FBQyxnQkFBZ0IsQ0FBQyxNQUFNLENBQUMsS0FBSyxDQUFDLElBQUksQ0FBQyxFQUFFO2dCQUN6QyxTQUFTO2FBQ1Y7WUFFRCxJQUFJLFlBQUMsQ0FBQyxVQUFVLENBQUMsTUFBTSxDQUFDLEtBQUssQ0FBQyxJQUFJLENBQUMsSUFBSSxZQUFDLENBQUMsU0FBUyxDQUFDLE1BQU0sQ0FBQyxLQUFLLENBQUMsSUFBSSxDQUFDLEVBQUU7Z0JBQ3JFLE1BQU07YUFDUDtTQUNGLFFBQVEsTUFBTSxHQUFHLE1BQU0sQ0FBQyxLQUFLLENBQUMsSUFBSSxDQUFDLFVBQVUsRUFBRTtRQUVoRCxJQUFJLFlBQUMsQ0FBQyxTQUFTLENBQUMsTUFBTSxDQUFDLEtBQUssQ0FBQyxJQUFJLENBQUMsRUFBRTtZQUNsQyxNQUFNLEtBQUssR0FBRyxFQUFFLENBQUM7WUFDakIsTUFBTSxLQUFLLEdBQUcsRUFBRSxDQUFDO1lBRWpCLGtFQUFrRTtZQUNsRSx1QkFBdUI7WUFDdkIsTUFBTSxDQUFDLEtBQUssQ0FBQyxJQUFJLENBQUMsSUFBSSxDQUFDLElBQUksQ0FBQyxNQUFNLENBQUMsSUFBSSxDQUFDLEVBQUU7Z0JBQ3hDLDJEQUEyRDtnQkFDM0QsSUFBSSxJQUFJLENBQUMsVUFBVSxFQUFFO29CQUNuQixLQUFLLENBQUMsSUFBSSxDQUFDLElBQUksQ0FBQyxDQUFDO2lCQUNsQjtxQkFDSTtvQkFDSCxLQUFLLENBQUMsSUFBSSxDQUFDLElBQUksQ0FBQyxDQUFDO2lCQUNsQjtZQUNILENBQUMsQ0FBQyxDQUFDO1lBRUgsTUFBTSxPQUFPLEdBQUcsWUFBQyxDQUFDLE9BQU8sQ0FBQztnQkFDeEIsR0FBRyxLQUFLO2dCQUNSLFlBQUMsQ0FBQyxtQkFBbUIsQ0FDbkIsWUFBQyxDQUFDLGNBQWMsQ0FDZCxZQUFDLENBQUMsZ0JBQWdCLENBQ2hCLFlBQUMsQ0FBQyxrQkFBa0IsQ0FDbEIsSUFBSSxFQUNKLEVBQUUsRUFDRixZQUFDLENBQUMsY0FBYyxDQUFDLEtBQUssQ0FBQyxDQUN4QixFQUNELFlBQUMsQ0FBQyxVQUFVLENBQUMsTUFBTSxDQUFDLENBQ3JCLEVBQ0QsQ0FBQyxZQUFDLENBQUMsVUFBVSxDQUFDLGdCQUFnQixDQUFDLENBQUMsQ0FDakMsQ0FDRjthQUNGLENBQUMsQ0FBQztZQUVILE1BQU0sQ0FBQyxLQUFLLENBQUMsSUFBSSxDQUFDLFdBQVcsQ0FBQyxPQUFPLENBQUMsQ0FBQztZQUN2QyxLQUFLLENBQUMsS0FBSyxHQUFHLElBQUksQ0FBQztTQUNwQjtJQUNILENBQUMsQ0FBQztJQUVGLE9BQU87UUFDTCxJQUFJO1lBQ0YsS0FBSyxDQUFDLE9BQU8sQ0FBQyxLQUFLLEVBQUUsQ0FBQztZQUN0QixLQUFLLENBQUMsT0FBTyxDQUFDLEtBQUssRUFBRSxDQUFDO1lBQ3RCLEtBQUssQ0FBQyxXQUFXLENBQUMsS0FBSyxFQUFFLENBQUM7WUFDMUIsS0FBSyxDQUFDLEtBQUssR0FBRyxLQUFLLENBQUM7UUFDdEIsQ0FBQztRQUVELE9BQU8sRUFBRTtZQUNQLE9BQU8sRUFBRTtnQkFDUCxJQUFJLENBQUMsSUFBSTtvQkFFUCxJQUFJLENBQUMsUUFBUSxDQUFDO3dCQUNaLGNBQWMsRUFBRTs0QkFDZCxJQUFJLENBQUMsSUFBSTtnQ0FDUCxNQUFNLEVBQUUsSUFBSSxFQUFFLEdBQUcsSUFBSSxDQUFDO2dDQUV0QixtRUFBbUU7Z0NBQ25FLG1FQUFtRTtnQ0FDbkUsSUFBSSxDQUFDLE9BQU8sQ0FBQyxXQUFXLElBQUksWUFBQyxDQUFDLFlBQVksQ0FBQyxJQUFJLENBQUMsTUFBTSxDQUFDLElBQUksSUFBSSxDQUFDLE1BQU0sQ0FBQyxJQUFJLEtBQUssU0FBUyxFQUFFO29DQUN6Riw0REFBNEQ7b0NBQzVELFVBQVU7b0NBQ1YsS0FBSyxDQUFDLEtBQUssR0FBRyxJQUFJLENBQUM7b0NBRW5CLGlEQUFpRDtvQ0FDakQsTUFBTSxRQUFRLEdBQUcsWUFBQyxDQUFDLGVBQWUsQ0FBQyxJQUFJLENBQUMsU0FBUyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUM7b0NBQ3RELE1BQU0sU0FBUyxHQUFHLFlBQUMsQ0FBQyxpQkFBaUIsQ0FBQyxJQUFJLENBQUMsU0FBUyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUM7b0NBRXpELDZEQUE2RDtvQ0FDN0QscUNBQXFDO29DQUNyQyxJQUFJLEdBQUcsR0FBRyxJQUFJLENBQUM7b0NBRWYsSUFBSSxRQUFRLEVBQUU7d0NBQ1osR0FBRyxHQUFvQixJQUFJLENBQUMsU0FBUyxDQUFDLENBQUMsQ0FBQyxDQUFDO3FDQUMxQzt5Q0FDSSxJQUFJLFNBQVMsRUFBRTt3Q0FDbEIsR0FBRyxHQUFHOzRDQUNKLEtBQUssRUFBc0IsSUFBSSxDQUFDLFNBQVMsQ0FBQyxDQUFDLENBQUUsQ0FBQyxNQUFNLENBQUMsQ0FBQyxDQUFDLENBQUMsS0FBSyxDQUFDLEdBQUc7eUNBQ2xFLENBQUM7cUNBQ0g7eUNBQ0ksSUFBSSxPQUFPLENBQUMsaUJBQWlCLEVBQUU7d0NBQ2xDLE1BQU0sR0FBRyxHQUFvQixJQUFJLENBQUMsU0FBUyxDQUFDLENBQUMsQ0FBQyxDQUFDO3dDQUMvQyxNQUFNLE9BQU8sR0FBRyxZQUFDLENBQUMsbUJBQW1CLENBQ25DLFlBQUMsQ0FBQyxjQUFjLENBQUMsWUFBQyxDQUFDLE1BQU0sRUFBRSxFQUFFLENBQUMsR0FBRyxDQUFDLENBQUMsQ0FDcEMsQ0FBQzt3Q0FFRixhQUFhO3dDQUNiLE9BQU8sQ0FBQyxVQUFVLEdBQUcsSUFBSSxDQUFDO3dDQUUxQixJQUFJLENBQUMsV0FBVyxDQUFDLE9BQU8sQ0FBQyxDQUFDO3dDQUUxQixPQUFPO3FDQUNSO3lDQUNJO3dDQUNILE1BQU0sSUFBSSxLQUFLLENBQUMsOEJBQThCLElBQUksQ0FBQyxRQUFRLEVBQUUsRUFBRSxDQUFDLENBQUM7cUNBQ2xFO29DQUVELE1BQU0sVUFBVSxHQUFHLEVBQUUsQ0FBQztvQ0FFdEIsMkJBQTJCO29DQUMzQixJQUFJLFlBQUMsQ0FBQyxlQUFlLENBQUMsSUFBSSxDQUFDLFVBQVUsQ0FBQyxJQUFJLENBQUMsRUFBRSxDQUFDLEVBQUU7d0NBQzlDLElBQUksQ0FBQyxVQUFVLENBQUMsSUFBSSxDQUFDLEVBQUUsQ0FBQyxVQUFVLENBQUMsT0FBTyxDQUFDLElBQUksQ0FBQyxFQUFFOzRDQUNoRCxVQUFVLENBQUMsSUFBSSxDQUFDLFlBQUMsQ0FBQyxlQUFlLENBQy9CLElBQUksQ0FBQyxLQUFLLEVBQ1YsSUFBSSxDQUFDLEdBQUcsQ0FDVCxDQUFDLENBQUM7NENBRUgsS0FBSyxDQUFDLE9BQU8sQ0FBQyxHQUFHLENBQUMsSUFBSSxDQUFDLEtBQUssQ0FBQyxJQUFJLENBQUMsQ0FBQzt3Q0FDckMsQ0FBQyxDQUFDLENBQUM7d0NBRUgsTUFBTSxJQUFJLEdBQUcsWUFBQyxDQUFDLGlCQUFpQixDQUM5QixVQUFVLEVBQ1YsWUFBQyxDQUFDLGFBQWEsQ0FBQyxHQUFHLENBQUMsS0FBSyxDQUFDLENBQzNCLENBQUM7d0NBRUYsYUFBYTt3Q0FDYixJQUFJLENBQUMsVUFBVSxHQUFHLElBQUksQ0FBQzt3Q0FFdkIsSUFBSSxDQUFDLEtBQUssQ0FBQyxnQkFBZ0IsRUFBRSxDQUFDLElBQUksQ0FBQyxnQkFBZ0IsQ0FBQyxNQUFNLEVBQUUsSUFBSSxDQUFDLENBQUM7d0NBQ2xFLElBQUksQ0FBQyxVQUFVLENBQUMsTUFBTSxFQUFFLENBQUM7cUNBQzFCO29DQUNELDZCQUE2Qjt5Q0FDeEIsSUFBSSxHQUFHLEVBQUU7d0NBQ1osTUFBTSxFQUFFLFVBQVUsRUFBRSxHQUFHLElBQUksQ0FBQzt3Q0FDNUIsTUFBTSxFQUFFLElBQUksRUFBRSxHQUFHLFVBQVUsQ0FBQyxJQUFJLENBQUM7d0NBQ2pDLGFBQWE7d0NBQ2IsTUFBTSxLQUFLLEdBQUcsQ0FBQyxZQUFDLENBQUMsa0JBQWtCLENBQUMsSUFBSSxDQUFDLENBQUMsQ0FBQyxDQUFDLElBQUksQ0FBQyxDQUFDLENBQUMsSUFBSSxDQUFDLEVBQUUsQ0FBQzt3Q0FFM0QsNENBQTRDO3dDQUM1QyxJQUFJLEVBQUUsR0FBRyxLQUFLLENBQUM7d0NBRWYsNkRBQTZEO3dDQUM3RCxJQUFJLENBQUMsS0FBSyxJQUFJLENBQUMsWUFBQyxDQUFDLFNBQVMsQ0FBQyxVQUFVLENBQUMsS0FBSyxDQUFDLElBQUksQ0FBQyxJQUFJLENBQUMsRUFBRTs0Q0FDdEQsRUFBRSxHQUFHLElBQUksQ0FBQyxLQUFLLENBQUMscUJBQXFCLENBQUMsR0FBRyxDQUFDLEtBQUssQ0FBQyxDQUFDO3lDQUNsRDt3Q0FFRCxxQ0FBcUM7d0NBQ3JDLEtBQUssQ0FBQyxPQUFPLENBQUMsR0FBRyxDQUFDLEVBQUUsQ0FBQyxJQUFJLENBQUMsQ0FBQzt3Q0FFM0IsZ0NBQWdDO3dDQUNoQyxNQUFNLElBQUksR0FBRyxZQUFDLENBQUMsaUJBQWlCLENBQzlCLENBQUMsWUFBQyxDQUFDLHNCQUFzQixDQUFDLEVBQUUsQ0FBQyxDQUFDLEVBQzlCLFlBQUMsQ0FBQyxhQUFhLENBQUMsR0FBRyxDQUFDLEtBQUssQ0FBQyxDQUMzQixDQUFDO3dDQUVGLGFBQWE7d0NBQ2IsSUFBSSxDQUFDLFVBQVUsR0FBRyxJQUFJLENBQUM7d0NBRXZCLDBDQUEwQzt3Q0FDMUMsSUFBSSxDQUFDLEtBQUssQ0FBQyxnQkFBZ0IsRUFBRSxDQUFDLElBQUksQ0FBQyxnQkFBZ0IsQ0FBQyxNQUFNLEVBQUUsSUFBSSxDQUFDLENBQUM7d0NBRWxFLDhEQUE4RDt3Q0FDOUQseUNBQXlDO3dDQUN6QyxJQUFJLEtBQUssSUFBSSxDQUFDLFlBQUMsQ0FBQyxpQkFBaUIsQ0FBQyxLQUFLLEVBQUUsRUFBRSxDQUFDLEVBQUU7NENBQzVDLE1BQU0sT0FBTyxHQUFHLFlBQUMsQ0FBQyxtQkFBbUIsQ0FDbkMsWUFBQyxDQUFDLG9CQUFvQixDQUNwQixHQUFHLEVBQ0gsS0FBSyxFQUNMLEVBQUUsQ0FDSCxDQUNGLENBQUM7NENBRUYsYUFBYTs0Q0FDYixPQUFPLENBQUMsVUFBVSxHQUFHLElBQUksQ0FBQzs0Q0FFMUIsSUFBSSxDQUFDLFVBQVUsQ0FBQyxVQUFVLENBQUMsV0FBVyxDQUFDLE9BQU8sQ0FBQyxDQUFDO3lDQUNqRDt3Q0FDRCxpRUFBaUU7d0NBQ2pFLDBCQUEwQjs2Q0FDckIsSUFBSSxDQUFDLEtBQUssRUFBRTs0Q0FDZixJQUFJLENBQUMsV0FBVyxDQUFDLEVBQUUsQ0FBQyxDQUFDO3lDQUN0Qjt3Q0FDRCwrQkFBK0I7NkNBQzFCOzRDQUNILElBQUksQ0FBQyxVQUFVLENBQUMsTUFBTSxFQUFFLENBQUM7eUNBQzFCO3FDQUNGO2lDQUNGOzRCQUNILENBQUM7eUJBQ0Y7cUJBQ0YsQ0FBQyxDQUFDO29CQUVILE1BQU0sV0FBVyxHQUFHLElBQUksQ0FBQyxLQUFLLENBQUMsZ0JBQWdCLEVBQUUsQ0FBQyxJQUFJLENBQUM7b0JBRXZELGtFQUFrRTtvQkFDbEUsOERBQThEO29CQUM5RCxnQkFBZ0I7b0JBQ2hCLElBQUksQ0FBQyxLQUFLLENBQUMsS0FBSyxFQUFFO3dCQUNoQixNQUFNLFVBQVUsR0FBRyxXQUFXOzZCQUMzQixHQUFHLENBQUMsTUFBTSxDQUFDOzZCQUNYLE1BQU0sQ0FBQyxDQUFDLENBQUMsRUFBRSxDQUFDLENBQUMsQ0FBQyxtQkFBbUIsRUFBRSxDQUFDOzZCQUNwQyxHQUFHLEVBQUUsQ0FBQzt3QkFFVCxNQUFNLFVBQVUsR0FBRyxXQUFXOzZCQUMzQixHQUFHLENBQUMsTUFBTSxDQUFDOzZCQUNYLE1BQU0sQ0FBQyxDQUFDLENBQUMsRUFBRSxDQUFDLENBQUMsQ0FBQyxtQkFBbUIsRUFBRSxDQUFDOzZCQUNwQyxHQUFHLEVBQUUsQ0FBQzt3QkFFVCxvQ0FBb0M7d0JBQ3BDLElBQUksQ0FBQyxVQUFVLElBQUksQ0FBQyxVQUFVLEVBQUU7NEJBQzlCLEtBQUssQ0FBQyxLQUFLLEdBQUcsSUFBSSxDQUFDO3lCQUNwQjtxQkFDRjtvQkFFRCxJQUFJLElBQUksQ0FBQyxJQUFJLENBQUMsVUFBVSxJQUFJLENBQUMsS0FBSyxDQUFDLEtBQUssRUFBRTt3QkFBRSxPQUFPO3FCQUFFO29CQUVyRCxNQUFNLFlBQVksR0FBRyxZQUFDLENBQUMsbUJBQW1CLENBQUMsS0FBSyxFQUFFO3dCQUNoRCxZQUFDLENBQUMsa0JBQWtCLENBQ2xCLFlBQUMsQ0FBQyxVQUFVLENBQUMsU0FBUyxDQUFDLEVBQ3ZCLFlBQUMsQ0FBQyxnQkFBZ0IsQ0FDaEIsWUFBQyxDQUFDLFVBQVUsQ0FBQyxRQUFRLENBQUMsRUFDdEIsWUFBQyxDQUFDLFVBQVUsQ0FBQyxTQUFTLENBQUMsQ0FDeEIsQ0FDRjtxQkFDRixDQUFDLENBQUM7b0JBRUgsTUFBTSxrQkFBa0IsR0FBRyxZQUFDLENBQUMsbUJBQW1CLENBQUMsS0FBSyxFQUFFO3dCQUN0RCxZQUFDLENBQUMsa0JBQWtCLENBQ2xCLFlBQUMsQ0FBQyxVQUFVLENBQUMsUUFBUSxDQUFDLEVBQ3RCLFlBQUMsQ0FBQyxnQkFBZ0IsQ0FBQzs0QkFDakIsWUFBQyxDQUFDLGNBQWMsQ0FDZCxZQUFDLENBQUMsVUFBVSxDQUFDLFNBQVMsQ0FBQyxFQUN2QixZQUFDLENBQUMsZ0JBQWdCLENBQUMsRUFBRSxDQUFDLENBQ3ZCO3lCQUNGLENBQUMsQ0FDSDtxQkFDRixDQUFDLENBQUM7b0JBRUgsYUFBYTtvQkFDYixZQUFZLENBQUMsVUFBVSxHQUFHLElBQUksQ0FBQztvQkFDL0IsYUFBYTtvQkFDYixrQkFBa0IsQ0FBQyxVQUFVLEdBQUcsSUFBSSxDQUFDO29CQUVyQyxnRUFBZ0U7b0JBQ2hFLHVDQUF1QztvQkFDdkMsTUFBTSxVQUFVLEdBQUcsV0FBVzt5QkFDM0IsR0FBRyxDQUFDLE1BQU0sQ0FBQzt5QkFDWCxNQUFNLENBQUMsQ0FBQyxDQUFDLEVBQUUsQ0FBQyxDQUFDLENBQUMsbUJBQW1CLEVBQUUsQ0FBQzt5QkFDcEMsR0FBRyxFQUFFLENBQUM7b0JBRVQsSUFBSSxVQUFVLEVBQUU7d0JBQ2QsVUFBVSxDQUFDLFdBQVcsQ0FBQyxZQUFZLENBQUMsQ0FBQzt3QkFDckMsVUFBVSxDQUFDLFdBQVcsQ0FBQyxrQkFBa0IsQ0FBQyxDQUFDO3FCQUM1Qzt5QkFDSTt3QkFDSCxXQUFXLENBQUMsZ0JBQWdCLENBQUMsTUFBTSxFQUFFLFlBQVksQ0FBQyxDQUFDO3dCQUNuRCxXQUFXLENBQUMsZ0JBQWdCLENBQUMsTUFBTSxFQUFFLGtCQUFrQixDQUFDLENBQUM7cUJBQzFEO29CQUVELE1BQU0sYUFBYSxHQUFHLFlBQUMsQ0FBQyx3QkFBd0IsQ0FDOUMsWUFBQyxDQUFDLGdCQUFnQixDQUNoQixZQUFDLENBQUMsVUFBVSxDQUFDLFFBQVEsQ0FBQyxFQUN0QixZQUFDLENBQUMsVUFBVSxDQUFDLFNBQVMsQ0FBQyxDQUN4QixDQUNGLENBQUM7b0JBRUYsSUFBSSxDQUFDLElBQUksQ0FBQyxVQUFVLEdBQUcsSUFBSSxDQUFDO29CQUM1QixhQUFhO29CQUNiLGFBQWEsQ0FBQyxVQUFVLEdBQUcsSUFBSSxDQUFDO29CQUVoQyxXQUFXLENBQUMsYUFBYSxDQUFDLE1BQU0sRUFBRSxhQUFhLENBQUMsQ0FBQztnQkFDbkQsQ0FBQzthQUNGO1lBRUQsY0FBYyxFQUFFLEVBQUUsS0FBSyxFQUFFO1lBQ3pCLGVBQWUsRUFBRSxFQUFFLEtBQUssRUFBRTtZQUUxQixlQUFlLEVBQUU7Z0JBQ2YsS0FBSyxDQUFDLElBQUk7b0JBQ1IsTUFBTSxFQUFFLElBQUksRUFBRSxHQUFHLElBQUksQ0FBQyxJQUFJLENBQUMsS0FBSyxDQUFDO29CQUVqQyw4REFBOEQ7b0JBQzlELElBQUksS0FBSyxDQUFDLE9BQU8sQ0FBQyxHQUFHLENBQUMsSUFBSSxDQUFDLEVBQUU7d0JBQzNCLE1BQU0sT0FBTyxHQUFHLFlBQUMsQ0FBQyxVQUFVLENBQUMsSUFBSSxDQUFDLENBQUM7d0JBQ25DLE1BQU0sT0FBTyxHQUFHLFlBQUMsQ0FBQyxVQUFVLENBQUMsS0FBSyxDQUFDLE9BQU8sQ0FBQyxHQUFHLENBQUMsSUFBSSxDQUFDLENBQUMsQ0FBQzt3QkFFdEQsSUFBSSxDQUFDLFdBQVcsQ0FBQyxZQUFDLENBQUMsZUFBZSxDQUFDLE9BQU8sRUFBRSxPQUFPLENBQUMsQ0FBQyxDQUFDO3FCQUN2RDtnQkFDSCxDQUFDO2FBQ0Y7WUFFRCxvQkFBb0IsRUFBRTtnQkFDcEIsS0FBSyxDQUFDLElBQUk7b0JBQ1IsSUFBSSxJQUFJLENBQUMsSUFBSSxDQUFDLFFBQVEsRUFBRTt3QkFDdEIsT0FBTztxQkFDUjtvQkFFRCxJQUFJLENBQUMsSUFBSSxDQUFDLFFBQVEsR0FBRyxJQUFJLENBQUM7b0JBRTFCLDRCQUE0QjtvQkFDNUIsSUFBSSxZQUFDLENBQUMsa0JBQWtCLENBQUMsSUFBSSxDQUFDLElBQUksQ0FBQyxJQUFJLENBQUMsRUFBRTt3QkFDeEMsTUFBTSxhQUFhLEdBQUcsSUFBSSxDQUFDLEtBQUssQ0FBQyxVQUFVLENBQUMsUUFBUSxDQUFDLENBQUM7d0JBQ3RELE1BQU0sY0FBYyxHQUFHLElBQUksQ0FBQyxLQUFLLENBQUMsVUFBVSxDQUFDLFNBQVMsQ0FBQyxDQUFDO3dCQUV4RCx1REFBdUQ7d0JBQ3ZELElBQUksWUFBQyxDQUFDLGtCQUFrQixDQUFDLElBQUksQ0FBQyxJQUFJLENBQUMsSUFBSSxDQUFDLE1BQU0sQ0FBQyxJQUFJLENBQ2pELElBQUksQ0FBQyxJQUFJLENBQUMsSUFBSSxDQUFDLE1BQU0sQ0FBQyxNQUFNLENBQUMsSUFBSSxLQUFLLFFBQVEsQ0FDL0MsRUFBRTs0QkFDRCxJQUFJLENBQUMsYUFBYSxFQUFFO2dDQUNsQixLQUFLLENBQUMsS0FBSyxHQUFHLElBQUksQ0FBQztnQ0FDbkIsT0FBTzs2QkFDUjt5QkFDRjs2QkFDSSxJQUNILFlBQUMsQ0FBQyxZQUFZLENBQUMsSUFBSSxDQUFDLElBQUksQ0FBQyxJQUFJLENBQUMsTUFBTSxDQUFDLElBQUksQ0FDdkMsSUFBSSxDQUFDLElBQUksQ0FBQyxJQUFJLENBQUMsTUFBTSxDQUFDLElBQUksS0FBSyxRQUFRLENBQ3hDLEVBQ0Q7NEJBQ0EsSUFBSSxDQUFDLGFBQWEsRUFBRTtnQ0FDbEIsS0FBSyxDQUFDLEtBQUssR0FBRyxJQUFJLENBQUM7Z0NBRW5CLDBDQUEwQztnQ0FDMUMsSUFBSSxZQUFDLENBQUMsZ0JBQWdCLENBQUMsSUFBSSxDQUFDLElBQUksQ0FBQyxLQUFLLENBQUMsRUFBRTtvQ0FDdkMsT0FBTztpQ0FDUjs2QkFDRjt5QkFDRjt3QkFDRCw0QkFBNEI7NkJBQ3ZCLElBQUksSUFBSSxDQUFDLElBQUksQ0FBQyxJQUFJLENBQUMsTUFBTSxDQUFDLElBQUksS0FBSyxTQUFTLEVBQUU7NEJBQ2pELE1BQU0sRUFBRSxJQUFJLEVBQUUsR0FBRyxJQUFJLENBQUMsSUFBSSxDQUFDLElBQUksQ0FBQyxRQUFRLENBQUM7NEJBQ3pDLElBQ0UsY0FBYztnQ0FDZCw0Q0FBNEM7Z0NBQzVDLDREQUE0RDtnQ0FDNUQsOEJBQThCO21DQUMzQixJQUFJLEtBQUssU0FBUyxFQUNyQjtnQ0FDQSxPQUFPOzZCQUNSOzRCQUVELEtBQUssQ0FBQyxLQUFLLEdBQUcsSUFBSSxDQUFDOzRCQUVuQixJQUFJLElBQUksR0FBRyxJQUFJLENBQUMsSUFBSSxDQUFDLEtBQUssQ0FBQzs0QkFFM0IsSUFDRSxDQUNFLElBQUksQ0FBQyxLQUFLLENBQUMsZ0JBQWdCLEVBQUUsQ0FBQyxVQUFVLENBQUMsSUFBSSxDQUFDLElBQUksQ0FBQztnQ0FDbkQsS0FBSyxDQUFDLE9BQU8sQ0FBQyxHQUFHLENBQUMsSUFBSSxDQUFDLElBQUksQ0FBQzs0QkFDOUIsNEJBQTRCOzZCQUMzQixJQUFJLElBQUksQ0FBQyxJQUFJLEtBQUssV0FBVyxFQUM5QjtnQ0FFQSxJQUFJLEdBQUcsSUFBSSxDQUFDLEtBQUssQ0FBQyxxQkFBcUIsQ0FBQyxJQUFJLENBQUMsSUFBSSxDQUFDLENBQUM7Z0NBRW5ELE1BQU0sT0FBTyxHQUFHLElBQUksQ0FBQyxJQUFJLENBQUMsS0FBSyxDQUFDLElBQUksQ0FBQztnQ0FDckMsS0FBSyxDQUFDLE9BQU8sQ0FBQyxHQUFHLENBQUMsT0FBTyxFQUFFLElBQUksQ0FBQyxJQUFJLENBQUMsQ0FBQztnQ0FFdEMsMkRBQTJEO2dDQUMzRCx5Q0FBeUM7Z0NBQ3pDLEtBQUssQ0FBQyxPQUFPLENBQUMsR0FBRyxDQUFDLElBQUksQ0FBQyxJQUFJLENBQUMsQ0FBQztnQ0FDN0IsSUFBSSxDQUFDLEdBQUcsQ0FBQyxPQUFPLENBQUMsQ0FBQyxXQUFXLENBQUMsSUFBSSxDQUFDLENBQUM7Z0NBQ3BDLElBQUksQ0FBQyxLQUFLLENBQUMsTUFBTSxDQUFDLE9BQU8sRUFBRSxJQUFJLENBQUMsSUFBSSxDQUFDLENBQUM7NkJBQ3ZDOzRCQUVELDZDQUE2Qzs0QkFDN0MsSUFBSTtnQ0FDRix1REFBdUQ7Z0NBQ3ZELHNDQUFzQztnQ0FDdEMsTUFBTSxPQUFPLEdBQUcsSUFBSSxDQUFDLEtBQUssQ0FBQyxxQkFBcUIsQ0FBQyxJQUFJLENBQUMsQ0FBQyxJQUFJLENBQUM7Z0NBRTVELElBQUksQ0FBQyxLQUFLLENBQUMsTUFBTSxDQUFDLElBQUksRUFBRSxPQUFPLENBQUMsQ0FBQztnQ0FFakMsTUFBTSxJQUFJLEdBQUcsWUFBQyxDQUFDLHNCQUFzQixDQUNuQyxZQUFDLENBQUMsbUJBQW1CLENBQUMsS0FBSyxFQUFFO29DQUMzQixZQUFDLENBQUMsa0JBQWtCLENBQ2xCLElBQUksQ0FBQyxJQUFJLENBQUMsSUFBSSxDQUFDLFFBQVEsRUFDdkIsWUFBQyxDQUFDLGdCQUFnQixDQUNoQixZQUFDLENBQUMsVUFBVSxDQUFDLFNBQVMsQ0FBQyxFQUN2QixJQUFJLENBQUMsSUFBSSxDQUFDLElBQUksQ0FBQyxRQUFRLENBQ3hCLENBQ0Y7aUNBQ0YsQ0FBQyxFQUNGLEVBQUUsQ0FDSCxDQUFDO2dDQUVGLElBQUksQ0FBQyxLQUFLLENBQUMsV0FBVyxDQUFDLEdBQUcsQ0FBQyxJQUFJLENBQUMsRUFBRTtvQ0FDaEMsSUFBSSxDQUFDLEtBQUssQ0FBQyxnQkFBZ0IsRUFBRSxDQUFDLElBQUksQ0FBQyxhQUFhLENBQUMsTUFBTSxFQUFFLElBQUksQ0FBQyxDQUFDO29DQUMvRCxLQUFLLENBQUMsV0FBVyxDQUFDLEdBQUcsQ0FBQyxJQUFJLENBQUMsQ0FBQztpQ0FDN0I7NkJBQ0Y7NEJBQ0QsV0FBTSxHQUFFO3lCQUNUO3FCQUNGO2dCQUNILENBQUM7YUFDRjtTQUNGO0tBQ0YsQ0FBQztBQUNKLENBQUMsQ0FBQyxDQUFDIn0=

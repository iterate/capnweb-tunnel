const LIFECYCLE_HOOKS = new Set(["beforeAll", "beforeEach", "afterAll", "afterEach"]);
const VI_MOCK_CALLS = new Set(["vi.mock", "vi.doMock"]);
const PROPERTY_MATCHERS = new Set(["toBe", "toEqual", "toStrictEqual"]);

function getPropertyName(node) {
  if (!node) return undefined;
  if (node.type === "Identifier") return node.name;
  if (node.type === "Literal" && typeof node.value === "string") return node.value;
  return undefined;
}

function getCallName(callee) {
  if (!callee) return undefined;
  if (callee.type === "Identifier") return callee.name;
  if (callee.type !== "MemberExpression") return undefined;
  const objectName = getCallObjectName(callee.object);
  const propertyName = getPropertyName(callee.property);
  if (!objectName || !propertyName) return undefined;
  return `${objectName}.${propertyName}`;
}

function getCallObjectName(node) {
  if (node.type === "Identifier") return node.name;
  if (node.type === "MemberExpression") return getCallName(node);
  if (node.type === "CallExpression") return getCallName(node.callee);
  return undefined;
}

function isDescribeCall(callee) {
  const name = getCallName(callee);
  return name === "describe" || Boolean(name?.startsWith("describe."));
}

function isLifecycleHookCall(callee) {
  return callee.type === "Identifier" && LIFECYCLE_HOOKS.has(callee.name);
}

function isViMockCall(callee) {
  const name = getCallName(callee);
  return Boolean(name && VI_MOCK_CALLS.has(name));
}

function isTestCallExpression(node) {
  if (!node || node.type !== "CallExpression") return false;
  const name = getCallName(node.callee);
  if (name === "test" || name === "it" || name?.startsWith("test.") || name?.startsWith("it.")) {
    return true;
  }
  return isTestCallExpression(node.callee);
}

function isFunctionLikeDeclaration(node) {
  if (node.type === "FunctionDeclaration" || node.type === "ClassDeclaration") return true;
  if (node.type !== "VariableDeclaration") return false;
  return node.declarations.some((declarator) => {
    const init = declarator.init;
    return (
      init &&
      (init.type === "FunctionExpression" ||
        init.type === "ArrowFunctionExpression" ||
        init.type === "ClassExpression")
    );
  });
}

function getMatcherCall(node) {
  if (node.callee.type !== "MemberExpression") return undefined;
  const matcherName = getPropertyName(node.callee.property);
  if (!PROPERTY_MATCHERS.has(matcherName)) return undefined;

  let expectChain = node.callee.object;
  if (expectChain.type === "MemberExpression" && getPropertyName(expectChain.property) === "not") {
    expectChain = expectChain.object;
  }

  if (
    expectChain.type !== "CallExpression" ||
    expectChain.callee.type !== "Identifier" ||
    expectChain.callee.name !== "expect"
  ) {
    return undefined;
  }

  const actual = expectChain.arguments[0];
  if (!actual || actual.type !== "MemberExpression") return undefined;
  if (actual.computed) return undefined;

  const propertyName = getPropertyName(actual.property);
  if (propertyName === "length") return undefined;

  return { actual, matcherName };
}

const plugin = {
  meta: {
    name: "captun",
  },
  rules: {
    "no-lifecycle-hooks": {
      meta: {
        type: "problem",
        docs: {
          description:
            "Disallow beforeEach/beforeAll/afterEach/afterAll in test files; use disposable fixtures instead.",
        },
      },
      create(context) {
        return {
          CallExpression(node) {
            if (!isLifecycleHookCall(node.callee)) return;
            context.report({
              node,
              message:
                "Avoid Vitest lifecycle hooks in test files. Prefer fixtures with Symbol.dispose or Symbol.asyncDispose.",
            });
          },
        };
      },
    },
    "no-describe": {
      meta: {
        type: "suggestion",
        docs: {
          description:
            "Keep test files flat so the first readable unit is the test itself, not a describe wrapper.",
        },
      },
      create(context) {
        return {
          CallExpression(node) {
            if (!isDescribeCall(node.callee)) return;
            context.report({
              node,
              message:
                "Avoid describe blocks. Keep tests as top-level test(...) calls unless grouping is truly necessary.",
            });
          },
        };
      },
    },
    "no-vi-mock": {
      meta: {
        type: "suggestion",
        docs: {
          description:
            "Avoid vi.mock in tests; prefer dependency injection and controllable fakes at the product boundary.",
        },
      },
      create(context) {
        return {
          CallExpression(node) {
            if (!isViMockCall(node.callee)) return;
            context.report({
              node,
              message:
                "Avoid vi.mock/vi.doMock in tests. Prefer dependency injection or a controllable fake dependency.",
            });
          },
        };
      },
    },
    "helpers-after-tests": {
      meta: {
        type: "suggestion",
        docs: {
          description:
            "Keep helper functions and fixture builders below the top-level tests in each test file.",
        },
      },
      create(context) {
        return {
          Program(node) {
            const lastTestIndex = node.body.findLastIndex((statement) => {
              return (
                statement.type === "ExpressionStatement" &&
                isTestCallExpression(statement.expression)
              );
            });
            if (lastTestIndex === -1) return;

            for (const statement of node.body.slice(0, lastTestIndex)) {
              if (!isFunctionLikeDeclaration(statement)) continue;
              context.report({
                node: statement,
                message:
                  "Move test helpers below the tests so the file opens with behavior, not setup.",
              });
            }
          },
        };
      },
    },
    "prefer-object-property-match": {
      meta: {
        type: "suggestion",
        docs: {
          description:
            "Prefer expect(object).toMatchObject({ property }) over expect(object.property).toBe(...).",
        },
      },
      create(context) {
        return {
          CallExpression(node) {
            const matcherCall = getMatcherCall(node);
            if (!matcherCall) return;

            const propertyName = getPropertyName(matcherCall.actual.property);
            const sourceText = context.sourceCode.getText(matcherCall.actual.object);
            const propertyText = propertyName ? `.${propertyName}` : ".[property]";
            context.report({
              node,
              message:
                `Prefer expect(${sourceText}).toMatchObject({ ${propertyName || "property"}: ... }) ` +
                `over expect(${sourceText}${propertyText}).${matcherCall.matcherName}(...).`,
            });
          },
        };
      },
    },
  },
};

export default plugin;

// Test/loopback proof only. Fail closed at every non-fixture data boundary.
export function p13FixturePlugin() {
  const mockFiles = ["client", "workouts", "activity", "coachClients"];
  return {
    name: "p13-fictional-boundaries",
    enforce: "pre",
    transform(code, id) {
      if (id.endsWith("/src/lib/supabase.js")) return "export const functionsBase = '/disabled'; export const supabase = new Proxy({}, {get(){throw new Error('Non-fixture data access blocked')}});";
      if (id.endsWith("/src/context/AuthContext.jsx")) return "export const useAuth = () => globalThis.__p13.auth; export const AuthProvider = ({children}) => children;";
      for (const file of mockFiles) {
        if (!id.endsWith(`/src/lib/${file}.js`)) continue;
        const names = [...code.matchAll(/export (?:async )?(?:function|const) (\w+)/g)].map((match) => match[1]);
        return names.map((name) => `export const ${name} = (...args) => { const fn = globalThis.__p13.${file}.${name}; if (!fn) throw new Error('Fixture operation not allowed: ${file}.${name}'); return fn(...args); };`).join("\n");
      }
      if (id.endsWith("/src/pages/Client.jsx")) return `${code}\nexport { ProgramTab as __ProgramTab, DayCard as __DayCard, MessagesTab as __MessagesTab };`;
    },
  };
}

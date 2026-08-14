import {
  createContext,
  useCallback,
  useContext,
  useState,
  type ReactNode,
} from "react";

const STORAGE_KEY = "shoppinglist.showHelpIcons";

interface HelpIconsValue {
  showHelp: boolean;
  setShowHelp: (v: boolean) => void;
}

/** 无 Provider 时的兜底：默认显示（预览页/单测直接使用 HelpIcon 时不报错） */
const HelpIconsContext = createContext<HelpIconsValue>({
  showHelp: true,
  setShowHelp: () => {},
});

function readStored(): boolean {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (v === null) return true; // 首次启动默认显示
    return v === "1" || v === "true";
  } catch {
    return true;
  }
}

export function HelpIconsProvider({ children }: { children: ReactNode }) {
  const [showHelp, setShowHelpState] = useState<boolean>(readStored);

  const setShowHelp = useCallback((v: boolean) => {
    setShowHelpState(v);
    try {
      localStorage.setItem(STORAGE_KEY, v ? "1" : "0");
    } catch {
      /* 写入失败忽略：仅影响持久化，不影响本次会话 */
    }
  }, []);

  return (
    <HelpIconsContext.Provider value={{ showHelp, setShowHelp }}>
      {children}
    </HelpIconsContext.Provider>
  );
}

export function useHelpIcons(): HelpIconsValue {
  return useContext(HelpIconsContext);
}

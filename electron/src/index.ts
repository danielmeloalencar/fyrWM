import { app, BrowserWindow, globalShortcut, ipcMain } from "electron";
import { spawn } from "child_process";
import { XDisplay, createClient } from "x11";
import ini from "ini";
import fs from "fs";
import path, { join } from "path";
import { FyrConfig, FyrWindow, SplitDirection } from "./types/FyrTypes";
import { logToFile, LogLevel, homedir, exec } from "./lib/utils";
import { defaultFyrConfig } from "./lib/config";
import {
  IX11Client,
  IX11Mod,
  IXClient,
  IXEvent,
  IXKeyEvent,
  IXScreen,
  X11_EVENT_TYPE,
  X11_KEY_MODIFIER,
  XFocusRevertTo,
} from "./types/X11Types";
const x11: IX11Mod = require("x11");
const wmLogFilePath = join(homedir(), ".fyr", "logs", "wm.log");
// Keysyms we care about – node‑x11 exposes an ASCII lookup helper
const KS = (k: string) => x11.keySyms[`XK_${k}`];

// These are standard PC keycodes – they’re stable on almost every layout
const KEY_SPACE = 65;
const KEY_Q = 24;
const KEY_V = 55;
const KEY_H = 43;
const SUPER = X11_KEY_MODIFIER.Mod4Mask;

// x11
let X: IXClient;
let client: IX11Client;
let root: number;
let screen: IXScreen = null;

// Switched with Super + V or Super + H, determines window split
let splitDirection = SplitDirection.Horizontal;

let launcherWid: number = null;
let launcherWindow: BrowserWindow = null;
let launcherInited: boolean = false;

// Used by compositor
let wmClassAtom;
let stringAtom;
let GetPropertyAsync: (...args) => Promise<any>;

// Track all open x11 windows
const openedWindows: Set<number> = new Set();
const allOpenedFyrWindows: Set<FyrWindow> = new Set();
let currentWindowId: number | null = null;
let currentResizableWindow: FyrWindow = null;

// Get user settings. Called immediately
const config: FyrConfig = (() => {
  const homeDir = process.env.HOME;
  if (!homeDir) {
    throw new Error("HOME directory is not set.");
  }
  const configPath = path.join(homeDir, ".fyr/wm/config.json");

  try {
    const rawData = fs.readFileSync(configPath, "utf-8");
    return JSON.parse(rawData);
  } catch (err) {
    const dirPath = path.dirname(configPath);
    if (!fs.existsSync(dirPath)) {
      fs.mkdirSync(dirPath, { recursive: true });
    }

    // Write the default config to the file if failure to read config
    fs.writeFileSync(
      configPath,
      JSON.stringify(defaultFyrConfig, null, 2),
      "utf-8"
    );

    return defaultFyrConfig;
  }
})();

// Depends on feh package
const setWallpaper = () => {
  const wallpaperPath = config.customizations.wallpaperPath;
  const command = `feh --bg-scale ${wallpaperPath}`;

  exec(command, (error) => {
    if (error) {
    } else {
      logToFile(wmLogFilePath, "Failed to set wallpaper", LogLevel.ERROR);
    }
  });
};

// Gets rid of X cursor when mouse is over desktop root
const setXRootCursor = (): void => {
  const command = `xsetroot -cursor_name arrow`;
  exec(command, (err) => {
    logToFile(wmLogFilePath, "Failed to set cursor", LogLevel.ERROR);
  });
};

// Needs picom installed, set window class to electronTransparent for a fully transparent window.
const initCompositing = (): void => {
  const command = `picom -b --config ~/.config/picom/picom.conf`;
  exec(command, (err) => {
    logToFile(
      wmLogFilePath,
      "Failed to initialize compositor" + err,
      LogLevel.ERROR
    );
  });
};

const initDesktop = async (display: XDisplay): Promise<number> => {
  logToFile(wmLogFilePath, "initing desktop", LogLevel.DEBUG);
  screen = display.screen[0];
  root = screen.root;
  X.MapWindow(root);
  setWallpaper();
  setXRootCursor();
  return root;
};

// Everything depends on this
const setCurrentResizableWindow = (
  windowId: number,
  width: number,
  height: number,
  x: number,
  y: number,
  horizontalParentId: number,
  verticalParentId: number,
  horizontalChildId,
  verticalChildId,
  lastSplitType: SplitDirection
) => {
  if (windowId === launcherWid) return;

  if (!isTopLevelApplication(windowId)) return;

  currentResizableWindow = {
    windowId,
    width,
    height,
    x,
    y,
    horizontalParentId,
    verticalParentId,
    horizontalChildId,
    verticalChildId,
    lastSplitType,
  };
};

const findFyrWindow = (wid: number): FyrWindow => {
  let foundWindow: FyrWindow = null;
  allOpenedFyrWindows.forEach((win) => {
    if (win.windowId === wid) {
      foundWindow = win;
    }
  });
  return foundWindow;
};

// Redundantly remove item just in case
const addFyrWind = (fyrWin: FyrWindow) => {
  if (fyrWin.windowId === launcherWid) return;
  const existing = findFyrWindow(fyrWin.windowId);
  if (existing) {
    logToFile(
      wmLogFilePath,
      "EXISTS ALREADY:" + JSON.stringify(fyrWin),
      LogLevel.ERROR
    );
  }

  allOpenedFyrWindows.forEach((win) => {
    if (win.windowId === fyrWin.windowId) {
      allOpenedFyrWindows.delete(win);
    }
  });
  allOpenedFyrWindows.add(fyrWin);
};

const deleteFyrWin = (wid: number) => {
  allOpenedFyrWindows.forEach((win) => {
    if (win.windowId === wid) {
      allOpenedFyrWindows.delete(win);
      return;
    }
  });
};

// Verifies that item should have tiling logic applied
const isTopLevelApplication = async (windowId: number): Promise<boolean> => {
  return new Promise((resolve, reject) => {
    X.QueryTree(windowId, (err, tree) => {
      if (err) {
        reject(err);
        return;
      }
      if (tree.parent === root) {
        X.GetWindowAttributes(windowId, (err, attrs) => {
          if (err) {
            reject(err);
            return;
          }
          if (!attrs.overrideRedirect) {
            resolve(true);
          } else {
            resolve(false);
          }
        });
      } else {
        resolve(false);
      }
    });
  });
};

// Handles map requests and determines size of tiles
const openApp = (
  appWid: number,
  splitDirection: number,
  currentWindowId?: number
) => {
  if (launcherWid === appWid) {
    X.MapWindow(appWid);
    return;
  }

  // const shouldRender = await isTopLevelApplication(appWid);

  // if (!shouldRender) return;

  if (!openedWindows.has(appWid)) openedWindows.add(appWid);

  if (openedWindows.size === 1) {
    // Gap
    X.ResizeWindow(appWid, screen.pixel_width - 10, screen.pixel_height - 10);
    // X.ReparentWindow(appWid, root, 5, 5);
    X.MoveWindow(appWid, 5, 5);
    X.MapWindow(appWid);
    X.ChangeWindowAttributes(
      appWid,
      {
        eventMask:
          x11.eventMask.StructureNotify |
          x11.eventMask.EnterWindow |
          x11.eventMask.LeaveWindow |
          x11.eventMask.KeyPress |
          x11.eventMask.KeyRelease |
          x11.eventMask.FocusChange |
          x11.eventMask.Exposure,
      },
      (err) => {
        logToFile(wmLogFilePath, JSON.stringify(err), LogLevel.ERROR);
      }
    );
    // X.SetInputFocus(appWid, XFocusRevertTo.PointerRoot);
    setCurrentResizableWindow(
      appWid,
      screen.pixel_width - 10,
      screen.pixel_height - 10,
      5,
      5,
      null,
      null,
      null,
      null,
      null
    );

    // First window has no pair, will be updated on next app open
    addFyrWind({
      windowId: appWid,
      width: screen.pixel_width - 10,
      height: screen.pixel_height - 10,
      x: 5,
      y: 5,
      horizontalParentId: null,
      verticalParentId: null,
      horizontalChildId: null,
      verticalChildId: null,
      lastSplitType: null,
    });

    return;
  } else {
    if (
      splitDirection === SplitDirection.Horizontal &&
      currentResizableWindow
    ) {
      // If horizonal selected, cut current window in half
      const newWidth = (currentResizableWindow.width - 5) / 2;
      const newX = currentResizableWindow.x + newWidth + 5;
      X.ResizeWindow(
        currentResizableWindow.windowId,
        newWidth,
        currentResizableWindow.height
      );
      X.MapWindow(currentResizableWindow.windowId);

      // Resize incoming window and map window
      X.ResizeWindow(appWid, newWidth, currentResizableWindow.height);
      X.MoveWindow(appWid, newX, currentResizableWindow.y);
      X.MapWindow(appWid);

      if (currentResizableWindow.horizontalChildId) {
        const newChild = findFyrWindow(
          currentResizableWindow.horizontalChildId
        );
        deleteFyrWin(newChild.windowId);
        addFyrWind({
          ...newChild,
          horizontalParentId: appWid,
        });
      }

      // Track new window with "parent" window id
      addFyrWind({
        windowId: appWid,
        width: newWidth,
        height: currentResizableWindow.height,
        x: newX,
        y: currentResizableWindow.y,
        horizontalParentId: currentResizableWindow.windowId,
        verticalParentId: null,
        horizontalChildId: currentResizableWindow.horizontalChildId
          ? currentResizableWindow.horizontalChildId
          : null,
        verticalChildId: null,
        lastSplitType: null,
      });

      // Modify existing window
      deleteFyrWin(currentResizableWindow.windowId);
      addFyrWind({
        ...currentResizableWindow,
        width: newWidth,
        // Last split type tracked in parent for resizing children on destroy
        lastSplitType: SplitDirection.Horizontal,
        horizontalChildId: appWid,
      });

      X.ChangeWindowAttributes(
        appWid,
        {
          eventMask:
            x11.eventMask.StructureNotify |
            x11.eventMask.EnterWindow |
            x11.eventMask.LeaveWindow |
            x11.eventMask.KeyPress |
            x11.eventMask.KeyRelease |
            x11.eventMask.FocusChange |
            x11.eventMask.Exposure,
        },
        (err) => {
          logToFile(wmLogFilePath, JSON.stringify(err), LogLevel.ERROR);
        }
      );

      setCurrentResizableWindow(
        appWid,
        newWidth,
        currentResizableWindow.height,
        newX,
        currentResizableWindow.y,
        currentResizableWindow.windowId,
        null,
        null,
        null,
        null
      );

      return;
    } else if (splitDirection === SplitDirection.Vertical) {
      // Cut in half
      const newHeight = (currentResizableWindow.height - 5) / 2;
      const newY = currentResizableWindow.y + newHeight + 5;
      X.ResizeWindow(
        currentResizableWindow.windowId,
        currentResizableWindow.width,
        newHeight
      );
      X.MapWindow(currentResizableWindow.windowId);

      // Resize incoming window and map window
      X.ResizeWindow(appWid, currentResizableWindow.width, newHeight);
      X.MoveWindow(appWid, currentResizableWindow.x, newY);
      X.MapWindow(appWid);

      if (currentResizableWindow.verticalChildId) {
        const newChild = findFyrWindow(currentResizableWindow.verticalChildId);
        deleteFyrWin(newChild.windowId);
        addFyrWind({
          ...newChild,
          verticalParentId: appWid,
        });
      }

      // Track new window
      addFyrWind({
        windowId: appWid,
        width: currentResizableWindow.width,
        height: newHeight,
        x: currentResizableWindow.x,
        y: newY,
        verticalParentId: currentResizableWindow.windowId,
        horizontalParentId: null,
        horizontalChildId: null,
        verticalChildId: currentResizableWindow.verticalChildId
          ? currentResizableWindow.verticalChildId
          : null,
        lastSplitType: null,
      });

      // Modify existing window
      deleteFyrWin(currentResizableWindow.windowId);
      addFyrWind({
        ...currentResizableWindow,
        height: newHeight,
        lastSplitType: SplitDirection.Vertical,
        verticalChildId: appWid,
      });

      X.ChangeWindowAttributes(
        appWid,
        {
          eventMask:
            x11.eventMask.StructureNotify |
            x11.eventMask.EnterWindow |
            x11.eventMask.LeaveWindow |
            x11.eventMask.KeyPress |
            x11.eventMask.KeyRelease |
            x11.eventMask.FocusChange |
            x11.eventMask.Exposure,
        },
        (err) => {
          logToFile(wmLogFilePath, JSON.stringify(err), LogLevel.ERROR);
        }
      );

      // Update current selected window for next resize
      setCurrentResizableWindow(
        appWid,
        currentResizableWindow.width,
        newHeight,
        currentResizableWindow.x,
        newY,
        null,
        currentResizableWindow.windowId,
        null,
        currentResizableWindow.verticalChildId
          ? currentResizableWindow.verticalChildId
          : null,
        null
      );
      return;
    }
    X.MapWindow(appWid);
    return;
  }
};

const GAP = 5; // 5 px spacing between tiles
const TOL = 2; // pixel drift tolerance
const eq = (a: number, b: number) => Math.abs(a - b) <= TOL;

const stripIsContiguous = (
  wins: FyrWindow[],
  axis: "x" | "y",
  size: "width" | "height"
): boolean => {
  if (wins.length === 0) return false;

  let cursor = wins[0][axis];
  for (const w of wins) {
    if (!eq(w[axis], cursor)) return false; // gap or overlap
    cursor += w[size] + GAP;
  }
  return true;
};

const stripMatchesLength = (
  wins: FyrWindow[],
  total: number,
  size: "width" | "height"
) =>
  eq(
    wins.reduce((s, w) => s + w[size], 0) + GAP * Math.max(wins.length - 1, 0),
    total
  );

const findBestChildrenMatch = (
  parent: FyrWindow
): [Array<FyrWindow>, SplitDirection] => {
  const bottom: FyrWindow[] = [];
  const right: FyrWindow[] = [];

  for (const w of Array.from(allOpenedFyrWindows)) {
    if (w.windowId === parent.windowId) continue;

    const touchesBottom =
      (eq(w.y, parent.y + parent.height) ||
        eq(w.y, parent.y + parent.height + GAP)) &&
      w.x >= parent.x &&
      w.x + w.width <= parent.x + parent.width + GAP;

    if (touchesBottom) bottom.push(w);

    const touchesRight =
      (eq(w.x, parent.x + parent.width) ||
        eq(w.x, parent.x + parent.width + GAP)) &&
      w.y >= parent.y &&
      w.y + w.height <= parent.y + parent.height + GAP;

    if (touchesRight) right.push(w);
  }

  // (a) vertical stack ⇒ heights add up
  bottom.sort((a, b) => a.x - b.x);
  if (
    stripIsContiguous(bottom, "x", "width") &&
    stripMatchesLength(bottom, parent.width, "width")
  ) {
    return [bottom, SplitDirection.Vertical];
  }

  // (b) horizontal row ⇒ widths add up
  right.sort((a, b) => a.y - b.y);
  if (
    stripIsContiguous(right, "y", "height") &&
    stripMatchesLength(right, parent.height, "height")
  ) {
    return [right, SplitDirection.Horizontal];
  }

  return [[], null];
};

const findBestParentMatch = (
  hole: FyrWindow
): [Array<FyrWindow>, SplitDirection] => {
  const top: FyrWindow[] = [];
  const left: FyrWindow[] = [];

  for (const p of Array.from(allOpenedFyrWindows)) {
    if (p.windowId === hole.windowId) continue;

    const touchesTop =
      (eq(p.y + p.height, hole.y) || eq(p.y + p.height + GAP, hole.y)) &&
      p.x >= hole.x &&
      p.x + p.width <= hole.x + hole.width + GAP;

    if (touchesTop) top.push(p);

    const touchesLeft =
      (eq(p.x + p.width, hole.x) || eq(p.x + p.width + GAP, hole.x)) &&
      p.y >= hole.y &&
      p.y + p.height <= hole.y + hole.height + GAP;

    if (touchesLeft) left.push(p);
  }

  top.sort((a, b) => a.x - b.x);
  if (
    stripIsContiguous(top, "x", "width") &&
    stripMatchesLength(top, hole.width, "width")
  ) {
    return [top, SplitDirection.Vertical];
  }

  left.sort((a, b) => a.y - b.y);
  if (
    stripIsContiguous(left, "y", "height") &&
    stripMatchesLength(left, hole.height, "height")
  ) {
    return [left, SplitDirection.Horizontal];
  }

  return [[], null];
};

const resizeRepositionReparentChildren = (
  deletedParent: FyrWindow,
  children: Array<FyrWindow>,
  splitType: SplitDirection
): void => {
  let immediateVertChild: FyrWindow;
  let immediateHorzChild: FyrWindow;
  children.forEach((childWindow) => {
    if (
      deletedParent.verticalChildId === childWindow.windowId ||
      childWindow.verticalParentId === deletedParent.windowId ||
      ((deletedParent.y + deletedParent.height + 5 === childWindow.y ||
        deletedParent.y + deletedParent.height === childWindow.y) &&
        deletedParent.x === childWindow.x)
    ) {
      immediateVertChild = childWindow;
    }

    if (
      deletedParent.horizontalChildId === childWindow.windowId ||
      childWindow.horizontalParentId === deletedParent.windowId ||
      //Sharing a horizontal border and starting at same y coordinate
      ((deletedParent.x + deletedParent.width + 5 === childWindow.x ||
        deletedParent.x + deletedParent.width === childWindow.x) &&
        deletedParent.y === childWindow.y)
    ) {
      immediateHorzChild = childWindow;
    }

    if (splitType === SplitDirection.Horizontal) {
      const [width, height]: [number, number] = [
        childWindow.width + deletedParent.width + 5,
        childWindow.height,
      ];
      const [x, y]: [number, number] = [deletedParent.x, childWindow.y];
      deleteFyrWin(childWindow.windowId);
      addFyrWind({
        ...childWindow,
        width,
        x,
      });
      X.ResizeWindow(childWindow.windowId, width, height);
      X.MoveWindow(childWindow.windowId, x, y);
      X.MapWindow(childWindow.windowId);
    } else if (splitType === SplitDirection.Vertical) {
      const [width, height]: [number, number] = [
        childWindow.width,
        childWindow.height + deletedParent.height + 5,
      ];
      const [x, y]: [number, number] = [childWindow.x, deletedParent.y];
      deleteFyrWin(childWindow.windowId);
      addFyrWind({
        ...childWindow,
        height,
        y,
      });
      X.ResizeWindow(childWindow.windowId, width, height);
      X.MoveWindow(childWindow.windowId, x, y);
      X.MapWindow(childWindow.windowId);
    }
  });

  if (immediateHorzChild && splitType === SplitDirection.Horizontal) {
    logToFile(wmLogFilePath, "UPDATING IMMEDIATE CHILD", LogLevel.DEBUG);
    deleteFyrWin(immediateHorzChild.windowId);
    addFyrWind({
      ...immediateHorzChild,
      x: deletedParent.x,
      width: immediateHorzChild.width + deletedParent.width + 5,
      verticalParentId: deletedParent.verticalParentId,
      horizontalParentId: deletedParent.horizontalParentId,
    });
  } else if (immediateVertChild) {
    logToFile(wmLogFilePath, "UPDATING IMMEDIATE CHILD", LogLevel.DEBUG);
    deleteFyrWin(immediateVertChild.windowId);
    addFyrWind({
      ...immediateVertChild,
      y: deletedParent.y,
      height: immediateVertChild.height + deletedParent.height + 5,
      verticalParentId: deletedParent.verticalParentId,
      horizontalParentId: deletedParent.horizontalParentId,
    });
  }
};

const resizeRepositionRechildParents = (
  childWindow: FyrWindow,
  parents: Array<FyrWindow>,
  splitType: SplitDirection
): void => {
  let immediateHorzParent: FyrWindow;
  let immediateVertParent: FyrWindow;
  let width: number;
  let height: number;

  parents.forEach((parentWindow) => {
    logToFile(
      wmLogFilePath,
      "PROBLEM PARENT:" + JSON.stringify(parentWindow),
      LogLevel.DEBUG
    );
    if (
      childWindow.horizontalParentId === parentWindow.windowId ||
      parentWindow.horizontalChildId === childWindow.windowId ||
      ((parentWindow.x + parentWindow.width + 5 === childWindow.x ||
        parentWindow.x + parentWindow.width === childWindow.x) &&
        parentWindow.y === childWindow.y)
    ) {
      immediateHorzParent = parentWindow;
    }

    if (
      parentWindow.verticalChildId === childWindow.windowId ||
      childWindow.verticalParentId === parentWindow.windowId ||
      // Sharing a vertical border and starting at the same X coordinate
      ((parentWindow.y + parentWindow.height + 5 === childWindow.y ||
        parentWindow.y + parentWindow.height === childWindow.y) &&
        parentWindow.x === childWindow.x)
    ) {
      immediateVertParent = parentWindow;
    }

    logToFile(
      wmLogFilePath,
      "IMMEDIATE VERTICAL PARENT: " + immediateVertParent,
      LogLevel.DEBUG
    );
    logToFile(
      wmLogFilePath,
      "IMMEDIATE HORZ PARENT: " + JSON.stringify(immediateHorzParent),
      LogLevel.DEBUG
    );

    if (splitType === SplitDirection.Horizontal) {
      width = parentWindow.width + childWindow.width + 5;
      deleteFyrWin(parentWindow.windowId);
      addFyrWind({
        ...parentWindow,
        width,
      });
      X.ResizeWindow(parentWindow.windowId, width, parentWindow.height);
      X.MapWindow(parentWindow.windowId);
    } else if (splitType === SplitDirection.Vertical) {
      height = parentWindow.height + childWindow.height + 5;
      deleteFyrWin(parentWindow.windowId);
      addFyrWind({
        ...parentWindow,
        height,
      });
      X.ResizeWindow(parentWindow.windowId, parentWindow.width, height);
      X.MapWindow(parentWindow.windowId);
    }
  });

  // Assign new grandchildren windows
  if (immediateHorzParent && splitType === SplitDirection.Horizontal) {
    deleteFyrWin(immediateHorzParent.windowId);
    addFyrWind({
      ...immediateHorzParent,
      horizontalChildId: childWindow.horizontalChildId
        ? childWindow.horizontalChildId
        : null,
      width,
    });
  } else if (immediateVertParent && splitType === SplitDirection.Vertical) {
    logToFile(
      wmLogFilePath,
      JSON.stringify(immediateVertParent),
      LogLevel.DEBUG
    );
    deleteFyrWin(immediateVertParent.windowId);
    addFyrWind({
      ...immediateVertParent,
      verticalChildId: childWindow.verticalChildId
        ? childWindow.verticalChildId
        : null,
      height,
    });
  }

  logToFile(
    wmLogFilePath,
    "FINISHED RESIZE REPARENT, NEW LIST IS: ",
    LogLevel.DEBUG
  );

  allOpenedFyrWindows.forEach((win) => {
    logToFile(wmLogFilePath, "window: " + JSON.stringify(win), LogLevel.DEBUG);
  });
};

const resizeOnDestroy = (deletedWindow: FyrWindow): void => {
  if (deletedWindow) {
    const [childrenToResize, childSplitType] =
      findBestChildrenMatch(deletedWindow);
    logToFile(
      wmLogFilePath,
      "Children size: " + childrenToResize.length.toString(),
      LogLevel.DEBUG
    );

    if (childrenToResize?.length > 0) {
      logToFile(
        wmLogFilePath,
        "Resize and reposition children: ",
        LogLevel.DEBUG
      );
      resizeRepositionReparentChildren(
        deletedWindow,
        childrenToResize,
        childSplitType
      );
      deleteFyrWin(deletedWindow.windowId);
      return;
    }
  }

  const [parentsToResize, parentSpltType] = findBestParentMatch(deletedWindow);
  if (parentsToResize?.length > 0) {
    logToFile(
      wmLogFilePath,
      "Parents size: " + parentsToResize.length.toString(),
      LogLevel.DEBUG
    );
    resizeRepositionRechildParents(
      deletedWindow,
      parentsToResize,
      parentSpltType
    );
    deleteFyrWin(deletedWindow.windowId);
    return;
  }

  logToFile(wmLogFilePath, "ERROR RESIZING", LogLevel.ERROR);
  deleteFyrWin(deletedWindow.windowId);
  return;
};

const handleDestroyNotify = (wid: number) => {
  const windowToDelete: FyrWindow = findFyrWindow(wid);
  logToFile(
    wmLogFilePath,
    "DELETING: " + JSON.stringify(windowToDelete),
    LogLevel.ERROR
  );
  if (windowToDelete) {
    if (openedWindows.has(wid)) {
      openedWindows.delete(wid);
      resizeOnDestroy(windowToDelete);
    }
  }
};

const initX11Client = async () => {
  client = await createClient(async (err, display: XDisplay) => {
    if (err) {
      logToFile(
        wmLogFilePath,
        `Error in X11 connection:${err}`,
        LogLevel.ERROR
      );
      return;
    }

    X = display.client;
    await initDesktop(display);
    logToFile(wmLogFilePath, "inited desktop", LogLevel.DEBUG);
    const grab = (mods: number, key: number) =>
      X.GrabKey(root, false, mods, key, 1 /*Async*/, 1 /*Async*/);

    X.InternAtom(false, "WM_CLASS", (err, atom) => {
      if (err) {
        console.error(err);
        return;
      }
      wmClassAtom = atom;
      X.InternAtom(false, "STRING", (err, atom) => {
        if (err) {
          console.error(err);
          return;
        }
        stringAtom = atom;
      });
    });

    X.ChangeWindowAttributes(
      root,
      {
        eventMask:
          x11.eventMask.SubstructureNotify |
          x11.eventMask.SubstructureRedirect |
          x11.eventMask.ButtonPress |
          x11.eventMask.ButtonRelease |
          x11.eventMask.KeyPress |
          x11.eventMask.KeyRelease,
      },
      (err) => {
        logToFile(
          wmLogFilePath,
          "Couldn't change event mask :(",
          LogLevel.ERROR
        );
      }
    );

    client.on("event", async (ev: IXEvent) => {
      logToFile(wmLogFilePath, "event", LogLevel.DEBUG);
      logToFile(wmLogFilePath, ev.type.toString(), LogLevel.DEBUG);
      const wid = ev.wid;
      switch (ev.type) {
        case X11_EVENT_TYPE.ButtonPress:
          if (wid) {
            if (wid === launcherWid) {
              focusWindow(launcherWid);
            } else {
              currentWindowId = wid;
              currentResizableWindow = findFyrWindow(wid);
              focusWindow(wid);
            }
          }
          break;
        case X11_EVENT_TYPE.KeyPress: {
          const { keycode } = ev as IXKeyEvent;
          const mods = (ev as IXKeyEvent).buttons;
          logToFile(wmLogFilePath, "key press", LogLevel.DEBUG);
          if (mods & SUPER) {
            logToFile(wmLogFilePath, "clicking shortcut keys", LogLevel.DEBUG);
          }

          if (ev.wid && ev.wid !== launcherWid) {
            currentWindowId = ev.wid;
            currentResizableWindow = findFyrWindow(ev.wid);
          }
          break;
        }
        case X11_EVENT_TYPE.EnterNotify:
          if (wid && wid !== launcherWid) {
            currentWindowId = wid;
            currentResizableWindow = findFyrWindow(wid);
            focusWindow(wid);
          }
          break;
        case X11_EVENT_TYPE.MapRequest:
          await openApp(wid, splitDirection, currentWindowId);
          if (wid !== launcherWid) {
            currentWindowId = wid;
            currentResizableWindow = findFyrWindow(wid);
            focusWindow(wid); // NEW ► focus new window
          }
          break;
        case X11_EVENT_TYPE.DestroyNotify:
          if (openedWindows.has(ev.wid)) handleDestroyNotify(ev.wid);
          if (currentWindowId === ev.wid) {
            if (openedWindows.size === 0) {
              currentWindowId = null;
              currentResizableWindow = null;
            } else {
              currentWindowId = Array.from(openedWindows).pop() || null;
              currentResizableWindow = findFyrWindow(currentWindowId);
            }
          }
          break;
      }
    });
  });
};

const focusWindow = (wid: number) => {
  if (!wid) return;
  X.SetInputFocus(wid, XFocusRevertTo.PointerRoot);
  X.RaiseWindow(wid);
};

const getElectronWindowId = (browserWindow: BrowserWindow): number => {
  const nativeHandle = browserWindow.getNativeWindowHandle();
  const wid = nativeHandle.readUint32LE(0);
  return wid;
};

app.whenReady().then(async () => {
  await initX11Client();
  initCompositing();
  const launcherShortcut = globalShortcut.register("Super+Space", () => {
    if (launcherWid) {
      X.DestroyWindow(launcherWid);
      launcherWid = null;
    } else {
      logToFile(wmLogFilePath, "opening launcher", LogLevel.DEBUG);
      openLauncher();
    }
  });

  const closeAppShortcut = globalShortcut.register("Super+Q", () => {
    if (currentResizableWindow) {
      X.DestroyWindow(currentResizableWindow.windowId);
    }
  });
  if (!closeAppShortcut) {
  }

  // Exit wm
  const closeWMShortcut = globalShortcut.register("Ctrl+Shift+Q", () => {
    app.quit();
  });
  if (!closeWMShortcut) {
  }

  // Window split directions
  const horizontalSplitShortcut = globalShortcut.register("Super+H", () => {
    splitDirection = SplitDirection.Horizontal;
  });

  if (!horizontalSplitShortcut) {
  }

  try {
    const verticalSplitShortcut = globalShortcut.register("Super+V", () => {
      splitDirection = SplitDirection.Vertical;
    });

    if (!verticalSplitShortcut) {
    }
  } catch (err) {}

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) initX11Client();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
  }
});

ipcMain.on("onLaunchApp", (event, appCommand) => {
  const [command, ...args] = appCommand.split(" ");
  const child = spawn(command, args, {
    env: { ...process.env },
    shell: true,
  });
  launcherWindow.hide();

  child.on("error", (error) => {});

  child.on("exit", (code) => {
    if (code !== null) {
    }
  });
});

ipcMain.handle("getApps", async () => {
  // Additional paths where .desktop files might be stored
  const appPaths = [
    "/usr/share/applications",
    "/usr/local/share/applications",
    `${process.env.HOME}/.local/share/applications`,
  ];

  const apps = [];

  for (const path of appPaths) {
    try {
      if (!fs.existsSync(path)) continue; // Skip if the path does not exist

      const files = fs.readdirSync(path);

      for (const file of files) {
        if (file.endsWith(".desktop")) {
          const filePath = `${path}/${file}`;
          const data = fs.readFileSync(filePath, "utf-8");
          const appConfig = ini.parse(data);

          const desktopEntry = appConfig["Desktop Entry"];
          if (
            desktopEntry &&
            desktopEntry.Name &&
            desktopEntry.Exec &&
            desktopEntry.Type === "Application" &&
            desktopEntry.Terminal !== "true"
          ) {
            apps.push({
              name: desktopEntry.Name,
              exec: desktopEntry.Exec,
            });
          }
        }
      }
    } catch (err) {
      // Optionally, log the error
      console.error(`Error reading applications from ${path}: ${err}`);
    }
  }

  return apps;
});

const setWmClass = (wid: number, cls: string) => {
  const val = Buffer.from(`${cls}\0${cls}\0`, "binary");
  X.InternAtom(false, "WM_CLASS", (_, a) =>
    X.InternAtom(false, "STRING", (_, s) =>
      X.ChangeProperty(0, wid, a, s, 8, val)
    )
  );
};

const getWinId = (bw: BrowserWindow) =>
  bw.getNativeWindowHandle().readUInt32LE(0);

const showLauncher = () => {
  if (!launcherWindow.isVisible()) launcherWindow.show(); // not showInactive
  focusWindow(launcherWid);
};

const setWindowClass = (windowId, className) => {
  const value = Buffer.from(`${className}\0${className}\0`, "binary");

  X.ChangeProperty(0, windowId, wmClassAtom, stringAtom, 8, value);
};

const openLauncher = () => {
  const [width, height] = [screen.pixel_width, screen.pixel_height];

  const [x, y] = [0, 0];

  launcherWindow = new BrowserWindow({
    width,
    height,
    x,
    y,
    frame: false,
    alwaysOnTop: true,
    resizable: false,
    movable: false,
    focusable: true,
    skipTaskbar: true,
    backgroundColor: "#000000",
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    },
  });

  launcherWindow.webContents.loadFile("./dist/vue/app-launcher.html");

  launcherWindow.setFullScreen(true);
  launcherWindow.setFocusable(true);
  launcherWindow.setAlwaysOnTop(true);
  launcherWid = getElectronWindowId(launcherWindow);
  launcherInited = true;
  setWindowClass(launcherWid, "electronTransparent");
  X.MapWindow(launcherWid);
  focusWindow(launcherWid);
  launcherWindow.webContents.executeJavaScript(
    `document.querySelector('input').focus();`
  );
};

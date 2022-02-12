export const sleep = (milliseconds: number) => {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
};

// FIXME: remove this (used only for milestoneMap and createPlaceholder)
export interface SimpleItem {
  iid: number;
  title: string;
  description?: string;
  state?: 'open' | 'closed';
}

export function pick<T, K extends keyof T>(obj: T, ...keys: K[]): Pick<T, K> {
  const ret: any = {};
  keys.forEach(key => {
    ret[key] = obj[key];
  });
  return ret;
}

export function omit<T, K extends keyof T>(obj: T, ...keys: K[]): Omit<T, K> {
  const ret: any = obj;
  keys.forEach(key => {
    delete ret[key];
  });
  return ret;
}

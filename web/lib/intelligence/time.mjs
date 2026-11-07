export const DAY = 86400000;
export const isoDay = value => new Date(value).toISOString().slice(0,10);
export const monthNumber = date => Number(date.slice(0,4))*12+Number(date.slice(5,7))-1;

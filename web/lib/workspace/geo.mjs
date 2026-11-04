export const BLOCKED_COUNTRIES=new Set(['CN','IN','RU','BY','UA','MD','EE','LV','LT','AM','AZ','GE','KZ','KG','TJ','TM','UZ','AL','BA','BG','HR','GR','XK','ME','MK','RO','RS','SI','CZ','HU','PL','SK']);
export function isCountryAllowed(country){return typeof country==='string'&&/^[A-Z]{2}$/.test(country)&&!BLOCKED_COUNTRIES.has(country);}

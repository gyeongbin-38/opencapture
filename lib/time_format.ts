function format(_fmt: string, date: Date) {
    let fmt = _fmt;
    const hours12 = date.getHours() % 12 || 12;
    const opt: { [key: string]: string | number } = {
        YYYY: date.getFullYear(),
        YY: String(date.getFullYear() % 100).padStart(2, "0"),
        MM: String(date.getMonth() + 1).padStart(2, "0"),
        M: date.getMonth() + 1,
        DD: String(date.getDate()).padStart(2, "0"),
        D: date.getDate(),
        d: date.getDay(),
        HH: String(date.getHours()).padStart(2, "0"),
        H: date.getHours(),
        hh: String(hours12).padStart(2, "0"),
        h: hours12,
        mm: String(date.getMinutes()).padStart(2, "0"),
        m: date.getMinutes(),
        ss: String(date.getSeconds()).padStart(2, "0"),
        s: date.getSeconds(),
        S: date.getMilliseconds(),
    };
    for (const k in opt) {
        const ret = new RegExp(`${k}`, "g");
        fmt = fmt.replace(ret, `${String(opt[k])}`);
    }
    return fmt;
}
export default format;

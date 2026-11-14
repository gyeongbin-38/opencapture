export type DashboardLanguageOption = { value: string; name: string };

export type DashboardLanguageSettings = {
    active: string;
    configured: string;
    pending: boolean;
    applies: "next-launch";
    options: DashboardLanguageOption[];
};

export function validateDashboardLanguage(
    value: unknown,
    supported: readonly string[],
) {
    if (typeof value !== "string" || !supported.includes(value))
        throw new Error("지원하지 않는 언어입니다.");
    return value;
}

export function dashboardLanguageSettings(
    active: string,
    configured: string,
    options: DashboardLanguageOption[],
): DashboardLanguageSettings {
    return {
        active,
        configured,
        pending: active !== configured,
        applies: "next-launch",
        options,
    };
}

export const dashboardLanguageDirection = (language: string) =>
    language === "ar" ? "rtl" : "ltr";

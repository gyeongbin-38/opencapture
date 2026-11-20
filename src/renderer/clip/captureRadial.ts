import { type ElType, button, view } from "dkh-ui";
import { radialLayout } from "../../../lib/captureControls";

type point = { x: number; y: number };
export type RadialTool = { id: string; title: string };

/** 右键径向菜单 + 按住右键滑动手势：自身持有菜单 DOM、分页、手势状态 */
export function createCaptureRadial<T extends RadialTool>(options: {
    t: (s: string) => string;
    icon: (id: string) => ElType<HTMLElement>;
    makeButton: (item: T) => ElType<HTMLButtonElement>;
    primaryItems: () => T[];
    secondaryItems: () => T[];
    buttonSize: () => number;
    primaryId: () => string;
    onOpen: () => void;
    onTool: (id: string, point: point) => void;
}) {
    const {
        t,
        icon,
        makeButton,
        primaryItems,
        secondaryItems,
        buttonSize,
        primaryId,
        onOpen,
        onTool,
    } = options;

    const menu = view()
        .attr({ id: "radial_menu", role: "menu", ariaLabel: t("캡처 도구") })
        .addInto();
    let open = false;
    let origin = { x: 0, y: 0 };
    let page = 0;
    let gesture: {
        x: number;
        y: number;
        moved: boolean;
        target: string | null;
        pointerId: number;
    } | null = null;
    let suppressContextUntil = 0;

    function pageCount() {
        return 1 + Math.ceil(secondaryItems().length / 7);
    }

    function gestureTarget(x: number, y: number): string | null {
        let nearest: HTMLButtonElement | null = null;
        let distance = 48;
        for (const control of menu.el.querySelectorAll<HTMLButtonElement>(
            ".radial_item",
        )) {
            control.classList.remove("is-gesture-target");
            if (control.disabled) continue;
            const d = Math.hypot(
                x - Number.parseFloat(control.style.left),
                y - Number.parseFloat(control.style.top),
            );
            if (d < distance) {
                nearest = control;
                distance = d;
            }
        }
        nearest?.classList.add("is-gesture-target");
        return nearest?.dataset.captureAction ?? null;
    }

    function close() {
        if (gesture) suppressContextUntil = Date.now() + 350;
        gesture = null;
        open = false;
        menu.style({ display: "none" });
        menu.el.replaceChildren();
    }

    function show(cx: number, cy: number, nextPage = 0) {
        onOpen();
        origin = { x: cx, y: cy };
        page = nextPage;
        const items =
            nextPage === 0
                ? primaryItems()
                : [
                      ...secondaryItems().slice(
                          (nextPage - 1) * 7,
                          nextPage * 7,
                      ),
                      {
                          id: "more",
                          title:
                              nextPage + 1 < pageCount()
                                  ? "다음 도구"
                                  : "처음으로",
                      } as T,
                  ];
        const layout = radialLayout(
            origin,
            { width: innerWidth, height: innerHeight },
            items.length,
            buttonSize(),
        );
        origin = { ...layout.center };
        menu.el.replaceChildren();
        menu.add(
            view()
                .class("radial-halo")
                .style({
                    left: `${layout.center.x}px`,
                    top: `${layout.center.y}px`,
                    width: `${layout.radius * 2}px`,
                    height: `${layout.radius * 2}px`,
                }),
        );
        menu.add(
            button(icon("close"))
                .class("radial-center")
                .attr({
                    type: "button",
                    title: t("닫기"),
                    ariaLabel: t("닫기"),
                })
                .style({
                    left: `${layout.center.x}px`,
                    top: `${layout.center.y}px`,
                })
                .on("click", close),
        );
        if (pageCount() > 1) {
            const dots = view("x")
                .attr({ role: "presentation" })
                .style({
                    position: "fixed",
                    left: `${layout.center.x}px`,
                    top: `${layout.center.y + 24}px`,
                    transform: "translate(-50%, -50%)",
                    gap: "5px",
                    zIndex: "121",
                    pointerEvents: "none",
                });
            for (let i = 0; i < pageCount(); i++) {
                const dot = view().style({
                    width: "5px",
                    height: "5px",
                    borderRadius: "50%",
                    background: i === page ? "#ffffff" : "#ffffff4d",
                });
                dot.el.dataset.radialPage = String(i);
                if (i === page) dot.el.setAttribute("aria-current", "page");
                dots.add(dot);
            }
            menu.add(dots);
        }
        for (const [index, item] of items.entries()) {
            const pt = layout.points[index];
            const control = makeButton(item)
                .class("radial_item")
                .attr({ role: "menuitem" })
                .style({ left: `${pt.x}px`, top: `${pt.y}px` });
            control.el.classList.toggle("is-primary", item.id === primaryId());
            control.el.style.setProperty(
                "--radial-from-x",
                `${layout.center.x - pt.x}px`,
            );
            control.el.style.setProperty(
                "--radial-from-y",
                `${layout.center.y - pt.y}px`,
            );
            control.el.style.animationDelay = `${index * 12}ms`;
            menu.add(control);
        }
        menu.style({ display: "block" });
        open = true;
        menu.el
            .querySelector<HTMLButtonElement>('[role="menuitem"]')
            ?.focus({ preventScroll: true });
    }

    document.addEventListener(
        "pointermove",
        (event) => {
            if (!gesture || gesture.pointerId !== event.pointerId) return;
            if (!(event.buttons & 2)) {
                close();
                return;
            }
            gesture.moved ||=
                Math.hypot(
                    event.clientX - gesture.x,
                    event.clientY - gesture.y,
                ) > 20;
            gesture.target = gestureTarget(event.clientX, event.clientY);
        },
        true,
    );
    document.addEventListener(
        "pointerup",
        (event) => {
            if (
                event.button !== 2 ||
                !gesture ||
                gesture.pointerId !== event.pointerId
            )
                return;
            const g = gesture;
            g.moved ||=
                Math.hypot(event.clientX - g.x, event.clientY - g.y) > 20;
            g.target = gestureTarget(event.clientX, event.clientY);
            gesture = null;
            suppressContextUntil = Date.now() + 350;
            if (g.moved) {
                if (g.target) {
                    const target = g.target;
                    if (target !== "more") close();
                    onTool(target, origin);
                } else close();
            }
        },
        true,
    );
    document.addEventListener(
        "pointercancel",
        (event) => {
            if (gesture?.pointerId === event.pointerId) close();
        },
        true,
    );

    return {
        open: show,
        close,
        nextPage: () => show(origin.x, origin.y, (page + 1) % pageCount()),
        relayout: () => {
            if (open) show(origin.x, origin.y, page);
        },
        isOpen: () => open,
        origin: () => origin,
        page: () => page,
        pageCount,
        contains: (node: Node) => menu.el.contains(node),
        controls: () =>
            Array.from(menu.el.querySelectorAll<HTMLButtonElement>("button")),
        gestureActive: () => gesture != null,
        contextSuppressed: () => Date.now() < suppressContextUntil,
        clearContextSuppress: () => {
            suppressContextUntil = 0;
        },
        startGesture: (event: PointerEvent) => {
            gesture = {
                x: event.clientX,
                y: event.clientY,
                moved: false,
                target: null,
                pointerId: event.pointerId,
            };
            show(event.clientX, event.clientY);
        },
    };
}

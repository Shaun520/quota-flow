"use client";

import { useId, type ReactNode } from "react";

interface IconProps {
  size?: number;
  className?: string;
}

export const IconDoubao = (p: IconProps) => (
  <svg width={p.size ?? 16} height={p.size ?? 16} viewBox="0 0 24 24" aria-hidden="true">
    <path d="M5.31 15.756c.172-3.75 1.883-5.999 2.549-6.739-3.26 2.058-5.425 5.658-6.358 8.308v1.12C1.501 21.513 4.226 24 7.59 24a6.59 6.59 0 002.2-.375c.353-.12.7-.248 1.039-.378.913-.899 1.65-1.91 2.243-2.992-4.877 2.431-7.974.072-7.763-4.5l.002.001z" fill="#1E37FC"></path><path d="M22.57 10.283c-1.212-.901-4.109-2.404-7.397-2.8.295 3.792.093 8.766-2.1 12.773a12.782 12.782 0 01-2.244 2.992c3.764-1.448 6.746-3.457 8.596-5.219 2.82-2.683 3.353-5.178 3.361-6.66a2.737 2.737 0 00-.216-1.084v-.002z" fill="#37E1BE"></path><path d="M14.303 1.867C12.955.7 11.248 0 9.39 0 7.532 0 5.883.677 4.545 1.807 2.791 3.29 1.627 5.557 1.5 8.125v9.201c.932-2.65 3.097-6.25 6.357-8.307.5-.318 1.025-.595 1.569-.829 1.883-.801 3.878-.932 5.746-.706-.222-2.83-.718-5.002-.87-5.617h.001z" fill="#A569FF"></path><path d="M17.305 4.961a199.47 199.47 0 01-1.08-1.094c-.202-.213-.398-.419-.586-.622l-1.333-1.378c.151.615.648 2.786.869 5.617 3.288.395 6.185 1.898 7.396 2.8-1.306-1.275-3.475-3.487-5.266-5.323z" fill="#1E37FC"></path>
  </svg>
);

export const IconJimeng = (p: IconProps) => {
  const uid = useId();
  return (
    <svg width={p.size ?? 16} height={p.size ?? 16} viewBox="0 0 24 24" aria-hidden="true">
      <g clipPath={`url(#${uid}-j0)`}><g transform="matrix(-0.009271 -0.017448 0.0215011 -0.0134883 13.0472 18.2292)"><rect fill={`url(#${uid}-j1)`} height="666.506" opacity="1" shapeRendering="crispEdges" width="1077.71" x="0" y="0"></rect><rect fill={`url(#${uid}-j1)`} height="666.506" opacity="1" shapeRendering="crispEdges" transform="scale(1 -1)" width="1077.71" x="0" y="0"></rect><rect fill={`url(#${uid}-j1)`} height="666.506" opacity="1" shapeRendering="crispEdges" transform="scale(-1 1)" width="1077.71" x="0" y="0"></rect><rect fill={`url(#${uid}-j1)`} height="666.506" opacity="1" shapeRendering="crispEdges" transform="scale(-1)" width="1077.71" x="0" y="0"></rect></g></g><g clipPath={`url(#${uid}-j2)`}><g transform="matrix(-0.00282575 -0.00489434 0.00971874 -0.00561112 16.5909 23.2227)"><rect fill={`url(#${uid}-j3)`} height="1485.61" opacity="1" shapeRendering="crispEdges" width="4828.03" x="0" y="0"></rect><rect fill={`url(#${uid}-j3)`} height="1485.61" opacity="1" shapeRendering="crispEdges" transform="scale(1 -1)" width="4828.03" x="0" y="0"></rect><rect fill={`url(#${uid}-j3)`} height="1485.61" opacity="1" shapeRendering="crispEdges" transform="scale(-1 1)" width="4828.03" x="0" y="0"></rect><rect fill={`url(#${uid}-j3)`} height="1485.61" opacity="1" shapeRendering="crispEdges" transform="scale(-1)" width="4828.03" x="0" y="0"></rect></g></g><defs><clipPath id={`${uid}-j0`}><path d="M5.25711 1.80765C8.76812 6.74075 14.4314 9.45056 20.0636 8.40323C20.4619 8.32917 20.8947 8.19661 21.3451 8.02311C22.2001 7.69374 23.3197 9.03389 22.6709 9.68084C22.2415 10.1091 21.8312 10.5013 21.4634 10.8278C18.9269 13.0793 16.1264 15.1096 13.0744 16.8717C10.003 18.6449 6.8237 20.0618 3.58429 21.1352C3.13145 21.2853 2.60446 21.4391 2.038 21.5917C1.15348 21.8301 0.554197 20.1919 1.2674 19.617C1.6464 19.3114 1.98071 19.0005 2.246 18.6902C5.96908 14.3363 6.29888 8.17371 3.71732 2.69665C3.6056 2.45961 3.48162 2.17153 3.35287 1.85684C2.99465 0.981289 4.04156 0.335123 4.65576 1.05462C4.89891 1.33945 5.10904 1.5996 5.25711 1.80765Z"></path></clipPath><clipPath id={`${uid}-j2`}><path d="M19.529 13.6948C17.2056 16.5579 16.7138 19.6388 17.1514 22.2781C17.1594 22.3264 17.1678 22.3799 17.1763 22.4375C17.2926 23.2284 16.3596 23.7154 15.7279 23.2254C15.6957 23.2004 15.6645 23.1765 15.6347 23.1538C13.5149 21.5401 11.0142 20.326 7.68635 20.7079C9.70085 20.1175 11.7605 19.243 13.7728 18.0812C15.9822 16.8056 17.9201 15.3074 19.529 13.6948Z"></path></clipPath><linearGradient gradientUnits="userSpaceOnUse" id={`${uid}-j1`} x1="0" x2="500" y1="0" y2="500"><stop stopColor="#27B2F0"></stop><stop offset="0.203234" stopColor="#26DFFB"></stop><stop offset="0.406468" stopColor="#30F5FE"></stop><stop offset="0.652506" stopColor="#F0FEFC"></stop><stop offset="0.863327" stopColor="#FBC610"></stop><stop offset="1" stopColor="#FD9C22"></stop></linearGradient><linearGradient gradientUnits="userSpaceOnUse" id={`${uid}-j3`} x1="0" x2="500" y1="0" y2="500"><stop stopColor="#1C6FFF"></stop><stop offset="1" stopColor="#24B5EF"></stop></linearGradient></defs>
    </svg>
  );
};

export const IconTongyi = (p: IconProps) => {
  const uid = useId();
  return (
    <svg width={p.size ?? 16} height={p.size ?? 16} viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12.604 1.34c.393.69.784 1.382 1.174 2.075a.18.18 0 00.157.091h5.552c.174 0 .322.11.446.327l1.454 2.57c.19.337.24.478.024.837-.26.43-.513.864-.76 1.3l-.367.658c-.106.196-.223.28-.04.512l2.652 4.637c.172.301.111.494-.043.77-.437.785-.882 1.564-1.335 2.34-.159.272-.352.375-.68.37-.777-.016-1.552-.01-2.327.016a.099.099 0 00-.081.05 575.097 575.097 0 01-2.705 4.74c-.169.293-.38.363-.725.364-.997.003-2.002.004-3.017.002a.537.537 0 01-.465-.271l-1.335-2.323a.09.09 0 00-.083-.049H4.982c-.285.03-.553-.001-.805-.092l-1.603-2.77a.543.543 0 01-.002-.54l1.207-2.12a.198.198 0 000-.197 550.951 550.951 0 01-1.875-3.272l-.79-1.395c-.16-.31-.173-.496.095-.965.465-.813.927-1.625 1.387-2.436.132-.234.304-.334.584-.335a338.3 338.3 0 012.589-.001.124.124 0 00.107-.063l2.806-4.895a.488.488 0 01.422-.246c.524-.001 1.053 0 1.583-.006L11.704 1c.341-.003.724.032.9.34zm-3.432.403a.06.06 0 00-.052.03L6.254 6.788a.157.157 0 01-.135.078H3.253c-.056 0-.07.025-.041.074l5.81 10.156c.025.042.013.062-.034.063l-2.795.015a.218.218 0 00-.2.116l-1.32 2.31c-.044.078-.021.118.068.118l5.716.008c.046 0 .08.02.104.061l1.403 2.454c.046.081.092.082.139 0l5.006-8.76.783-1.382a.055.055 0 01.096 0l1.424 2.53a.122.122 0 00.107.062l2.763-.02a.04.04 0 00.035-.02.041.041 0 000-.04l-2.9-5.086a.108.108 0 010-.113l.293-.507 1.12-1.977c.024-.041.012-.062-.035-.062H9.2c-.059 0-.073-.026-.043-.077l1.434-2.505a.107.107 0 000-.114L9.225 1.774a.06.06 0 00-.053-.031zm6.29 8.02c.046 0 .058.02.034.06l-.832 1.465-2.613 4.585a.056.056 0 01-.05.029.058.058 0 01-.05-.029L8.498 9.841c-.02-.034-.01-.052.028-.054l.216-.012 6.722-.012z" fill={`url(#${uid}-q0)`} fillRule="nonzero"></path><defs><linearGradient id={`${uid}-q0`} x1="0%" x2="100%" y1="0%" y2="0%"><stop offset="0%" stopColor="#6336E7" stopOpacity=".84"></stop><stop offset="100%" stopColor="#6F69F7" stopOpacity=".84"></stop></linearGradient></defs>
    </svg>
  );
};

export const IconYuanbao = (p: IconProps) => (
  <svg width={p.size ?? 16} height={p.size ?? 16} viewBox="0 0 24 24" aria-hidden="true">
    <path d="M7.063 1.664C5.198 3.338 4.395 6.67 5.782 8.568c1.47 2.014 4.79 1.745 6.953.113 2.434-1.84 6.033-1.793 7.23.953.91 2.207.067 4.927-2.113 6.483-4.302 3.097-10.577 2.52-13.472-1.444-2.86-3.915-1.35-9.696 2.683-13.011v.002z" fill="#fff"></path><path d="M12.007.647C5.384.647.015 5.734.015 12.007s5.369 11.36 11.992 11.36C18.631 23.366 24 18.28 24 12.006 24 5.732 18.631.647 12.007.647zm5.846 15.472C13.55 19.216 7.275 18.64 4.38 14.675 1.521 10.759 3.03 4.979 7.064 1.664 5.199 3.338 4.396 6.67 5.782 8.568c1.47 2.014 4.791 1.745 6.954.112 2.433-1.838 6.032-1.792 7.23.954.91 2.207.067 4.926-2.113 6.483v.002z" fill="#00CC70"></path><path d="M14.801 14.904a.669.669 0 01-.536-.269l-1.02-1.37a.67.67 0 01.006-.806l1.02-1.328a.668.668 0 011.059.815l-.712.925.72.963a.67.67 0 01-.535 1.066l-.002.004zm-3.931-2.001c0 1.797-.356 2.135-1.16 2.135-.806 0-1.162-.338-1.162-2.135 0-1.796.357-2.134 1.161-2.134.805 0 1.162.338 1.162 2.134h-.001z" fill="#1C1C1C"></path>
  </svg>
);

export const IconKling = (p: IconProps) => {
  const uid = useId();
  return (
    <svg width={p.size ?? 16} height={p.size ?? 16} viewBox="0 0 24 24" aria-hidden="true">
      <path d="M5.412 13.775A23.193 23.193 0 017.41 9.32c3.17-5.492 7.795-8.757 10.33-7.294C12.038-1.266 4.598.944 1.122 6.964A13.378 13.378 0 00.085 9.22c-.259.739.092 1.534.77 1.926l4.557 2.63z" fill={`url(#${uid}-k0)`}></path><path d="M18.588 10.164a23.188 23.188 0 01-1.999 4.455c-3.17 5.492-7.795 8.758-10.33 7.294 5.703 3.293 13.143 1.082 16.619-4.938a13.392 13.392 0 001.037-2.255c.259-.738-.092-1.534-.77-1.925l-4.557-2.63z" fill={`url(#${uid}-k1)`}></path><path d="M16.59 14.62c3.17-5.492 3.686-11.13 1.15-12.594C15.207.563 10.582 3.83 7.41 9.32c2.074-3.59 5.809-5.315 8.344-3.852 2.534 1.464 2.908 5.56.835 9.151z" fill={`url(#${uid}-k2)`}></path><path d="M7.41 9.32c-3.17 5.492-3.686 11.13-1.15 12.593 2.534 1.464 7.159-1.802 10.33-7.294-2.074 3.591-5.809 5.316-8.344 3.852-2.534-1.463-2.908-5.56-.835-9.15z" fill={`url(#${uid}-k3)`}></path><defs><radialGradient cx="0" cy="0" gradientTransform="matrix(7.47772 -12.51022 17.14368 10.24728 5.173 13.637)" gradientUnits="userSpaceOnUse" id={`${uid}-k0`} r="1"><stop offset=".095" stopColor="#FFF959"></stop><stop offset=".326" stopColor="#0DF35E"></stop><stop offset=".64" stopColor="#0BF2F9"></stop><stop offset="1" stopColor="#04A6F0"></stop></radialGradient><radialGradient cx="0" cy="0" gradientTransform="rotate(120.868 6.491 10.491) scale(14.5747 19.9728)" gradientUnits="userSpaceOnUse" id={`${uid}-k1`} r="1"><stop offset=".095" stopColor="#FFF959"></stop><stop offset=".326" stopColor="#0DF35E"></stop><stop offset=".64" stopColor="#0BF2F9"></stop><stop offset="1" stopColor="#04A6F0"></stop></radialGradient><linearGradient gradientUnits="userSpaceOnUse" id={`${uid}-k2`} x1="15.578" x2="18.062" y1="1.798" y2="9.861"><stop stopColor="#003EFF"></stop><stop offset="1" stopColor="#0BFFE7"></stop></linearGradient><linearGradient gradientUnits="userSpaceOnUse" id={`${uid}-k3`} x1="8.422" x2="5.938" y1="22.142" y2="14.079"><stop stopColor="#003EFF"></stop><stop offset="1" stopColor="#0BFFE7"></stop></linearGradient></defs>
    </svg>
  );
};

export const IconHailuo = (p: IconProps) => {
  const uid = useId();
  return (
    <svg width={p.size ?? 16} height={p.size ?? 16} viewBox="0 0 24 24" aria-hidden="true">
      <path d="M24 12C24 5.373 18.6-.017 11.97 0 5.39.017.015 5.39 0 11.97-.017 18.6 5.373 24 12 24h7.885a4.108 4.108 0 004.108-4.108V12.4c.004-.133.007-.266.007-.4zM5.829 18.664c-1.91-1.63-3.088-4.24-3.033-6.9.004-.186.013-.372.03-.558v-.012c.277-3.174 2.327-6.134 5.2-7.509 2.874-1.375 6.466-1.112 9.11.664 2.644 1.777 4.243 5.004 4.056 8.184a11.38 11.38 0 01-.329 2.063c-.066.27-.147.549-.338.75-.19.201-.524.295-.75.134-.216-.154-.248-.456-.266-.72-.15-2.134-.72-4.335-2.162-5.915A6.636 6.636 0 0013.1 6.743a6.858 6.858 0 00-4.577 1.252c-1.099.787-1.962 1.914-2.38 3.2-.416 1.285-.374 2.726.175 3.962a5.24 5.24 0 001.9 2.24c1.467.963 3.475 1.1 5 .23 1.524-.87 2.435-2.758 2.047-4.47-.389-1.712-2.124-3.047-3.87-2.866-.266.027-.648-.002-.657-.27-.008-.207.241-.316.445-.353 1.771-.318 3.67.582 4.64 2.097.973 1.515 1.022 3.544.229 5.16-.794 1.615-2.37 2.795-4.118 3.221-2.357.575-4.491-.105-6.103-1.482h-.002z" fill={`url(#${uid}-h0)`}></path><defs><linearGradient gradientUnits="userSpaceOnUse" id={`${uid}-h0`} x1=".539" x2="27.487" y1=".884" y2="27.022"><stop offset=".09" stopColor="#FFAB0C"></stop><stop offset=".31" stopColor="#FF5538"></stop><stop offset=".46" stopColor="#E9405D"></stop><stop offset=".75" stopColor="#D266DA"></stop><stop offset=".89" stopColor="#D584EF"></stop></linearGradient></defs>
    </svg>
  );
};

export const IconMathMind = (p: IconProps) => {
  const uid = useId();
  return (
    <svg width={p.size ?? 16} height={p.size ?? 16} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x="0.5" y="0.5" width="23" height="23" rx="5.5" fill={`url(#${uid}-mm)`} />
      <path
        d="M7.5 16.5v-9l4.5 4.5 4.5-4.5v9"
        stroke="#fff"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <defs>
        <linearGradient id={`${uid}-mm`} x1="0" y1="0" x2="24" y2="24" gradientUnits="userSpaceOnUse">
          <stop stopColor="#3B82F6" />
          <stop offset="1" stopColor="#8B5CF6" />
        </linearGradient>
      </defs>
    </svg>
  );
};

export type ProviderIcon = (p: IconProps) => ReactNode;

export const PROVIDER_ICONS: Record<string, ProviderIcon> = {
  doubao: IconDoubao,
  jimeng: IconJimeng,
  qwenwan: IconTongyi,
  qwen: IconTongyi,
  yuanbao: IconYuanbao,
  kling: IconKling,
  hailuo: IconHailuo,
  mathmind: IconMathMind
};

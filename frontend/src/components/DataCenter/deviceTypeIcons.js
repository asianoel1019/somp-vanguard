// Line icons of the rack device types (react-icons/tb), drawn on the devices, in the type filter and the legend.
// Kept apart from rackShared.js so that file stays free of React.
import {
  TbArchive, TbArrowsHorizontal, TbArrowsSplit, TbBarrierBlock, TbBattery3, TbCloudComputing, TbDatabase, TbFlame,
  TbFolders, TbGridDots, TbHeart, TbKey, TbKeyboard, TbLayoutRows, TbPlug, TbRouter, TbServer, TbShieldLock, TbStack,
  TbSwitchHorizontal,
} from 'react-icons/tb';

export const DEVICE_TYPE_ICONS = {
  Server: TbServer,
  Nutanix: TbCloudComputing,
  BladeChassis: TbLayoutRows,
  Switch: TbSwitchHorizontal,
  Router: TbRouter,
  Firewall: TbFlame,
  LoadBalancer: TbArrowsSplit,
  Proxy: TbShieldLock,
  ISE: TbKey,
  Storage: TbDatabase,
  NAS: TbFolders,
  TapeLibrary: TbArchive,
  PatchPanel: TbGridDots,
  PowerBar: TbPlug,
  UPS: TbBattery3,
  KVM: TbKeyboard,
  CableManagement: TbArrowsHorizontal,
  Shelf: TbStack,
  Reserve: TbBarrierBlock,
  KuaiKuai: TbHeart,
};

/** Icon component of a device type (a server for unknown types). */
export const deviceTypeIcon = (type) => DEVICE_TYPE_ICONS[type] || TbServer;

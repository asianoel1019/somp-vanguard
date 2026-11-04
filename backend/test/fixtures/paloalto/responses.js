// Recorded-shape PAN-OS XML API answers (addresses from the documentation ranges), keyed by a part of the request.
const ok = (inner) => `<response status="success"><result>${inner}</result></response>`;

module.exports = {
    keygen: ok('<key>GENERATED-KEY-abcdef</key>'),
    '<show><system><info>': ok(`<system><hostname>pa-lab-01</hostname><ip-address>192.0.2.250</ip-address><model>PA-440</model>
        <serial>0123456789AB</serial><sw-version>11.1.2</sw-version><uptime>12 days, 3:04:05</uptime><multi-vsys>off</multi-vsys></system>`),
    '<show><system><resources>': ok(`<![CDATA[top - 10:00:00 up 12 days
%Cpu(s):  2.0 us,  1.0 sy,  0.0 ni, 95.0 id,  0.0 wa
MiB Mem :   7800.0 total,   3900.0 free,   3120.0 used,    780.0 buff/cache]]>`),
    '<show><session><info>': ok('<num-active>1834</num-active><num-max>262144</num-max>'),
    '<show><high-availability><state>': ok(`<enabled>yes</enabled><group><mode>Active-Passive</mode><group-id>1</group-id>
        <local-info><state>active</state><priority>100</priority><serial-num>0123456789AB</serial-num><mgmt-ip>192.0.2.250/24</mgmt-ip></local-info>
        <peer-info><state>passive</state><priority>110</priority><serial-num>0123456789AC</serial-num></peer-info></group>`),
    '<show><interface>all': ok(`<ifnet>
        <entry><name>ethernet1/1</name><zone>untrust</zone><fwd>vr:default</fwd><vsys>1</vsys><tag>0</tag><ip>203.0.113.2/29</ip></entry>
        <entry><name>ethernet1/2.10</name><zone>trust</zone><fwd>vr:default</fwd><vsys>1</vsys><tag>10</tag><ip>192.0.2.1/24</ip></entry>
        <entry><name>ethernet1/3</name><zone/><fwd>N/A</fwd><vsys>1</vsys><tag>0</tag><ip>N/A</ip></entry>
    </ifnet><hw>
        <entry><name>ethernet1/1</name><state>up</state><speed>1000</speed><duplex>full</duplex></entry>
        <entry><name>ethernet1/2</name><state>up</state><speed>1000</speed></entry>
        <entry><name>ethernet1/3</name><state>down</state><speed>ukn</speed></entry>
    </hw>`),
    'rulebase/security/rules': ok(`<rules>
        <entry name="Allow-Web" uuid="u1"><from><member>trust</member></from><to><member>untrust</member></to>
            <source><member>any</member></source><destination><member>any</member></destination>
            <application><member>web-browsing</member><member>ssl</member></application><service><member>application-default</member></service>
            <action>allow</action><description>outbound &amp; web</description></entry>
        <entry name="Deny-Telnet" uuid="u2"><from><member>untrust</member></from><to><member>trust</member></to>
            <source><member>any</member></source><destination><member>srv-web</member></destination>
            <application><member>telnet</member></application><service><member>any</member></service>
            <action>deny</action><disabled>yes</disabled></entry>
    </rules>`),
    '<rule-hit-count>': ok(`<rule-hit-count><vsys><entry name="vsys1"><rule-base><entry name="security"><rules>
        <entry name="Allow-Web"><hit-count>5120</hit-count><last-hit-timestamp>1762200000</last-hit-timestamp></entry>
    </rules></entry></rule-base></entry></vsys></rule-hit-count>`),
    '<show><routing><route>': ok(`
        <entry><virtual-router>default</virtual-router><destination>0.0.0.0/0</destination><nexthop>203.0.113.1</nexthop><metric>10</metric><flags>A S</flags><interface>ethernet1/1</interface></entry>
        <entry><virtual-router>default</virtual-router><destination>192.0.2.0/24</destination><nexthop>0.0.0.0</nexthop><metric>0</metric><flags>A C</flags><interface>ethernet1/2.10</interface></entry>`),
    '<show><session><all>': ok(`
        <entry><proto>6</proto><source>192.0.2.10</source><sport>51000</sport><dst>198.51.100.20</dst><dport>443</dport>
            <security-rule>Allow-Web</security-rule><application>ssl</application><state>ACTIVE</state></entry>`),
    '<show><vpn><flow>': ok(`<IPSec><entry><name>to-branch</name><state>active</state><peerip>198.51.100.200</peerip></entry>
        <entry><name>to-dr</name><state>init</state><peerip>198.51.100.201</peerip></entry></IPSec>`),
    '<global-protect-gateway>': ok(`<entry><domain>corp</domain><username>remote-user</username><public-ip>203.0.113.99</public-ip>
        <virtual-ip>192.0.2.200</virtual-ip><login-time-utc>1762200000</login-time-utc></entry>`),
};

import { useEffect, useState } from 'react';
import api from '../api';
import { normalizeEnvs } from '../utils/environments';

// Global Environments list (Settings -> Environments), normalised: isProduction / exactly one isDefault
export default function useEnvironments() {
    const [envs, setEnvs] = useState([]);
    useEffect(() => {
        let alive = true;
        api.get('/environments')
            .then(res => { if (alive) setEnvs(normalizeEnvs(res.data)); })
            .catch(() => { if (alive) setEnvs([]); });
        return () => { alive = false; };
    }, []);
    return envs;
}
